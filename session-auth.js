'use strict';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const {
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    shouldBlockLoginNavigation,
    isLoginPageContent,
    hasVisibleLoginChrome,
    hasLoggedInChatUi,
    waitForLoggedInChatUi,
    hasLoggedInSessionApi,
    buildSessionNotLoggedInError
} = require('./auth-page-detect');

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
        return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (_) {
        return null;
    }
}

function extractProfileFromToken(accessToken) {
    const payload = decodeJwtPayload(accessToken);
    if (!payload) {
        return { email: '', accountId: '', userId: '' };
    }
    const authInfo = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
        email: profile.email || '',
        accountId: authInfo.chatgpt_account_id || '',
        userId: authInfo.chatgpt_user_id || ''
    };
}

function buildSessionPayload(accessToken, sessionJson = null) {
    const token = String(accessToken || '').trim();
    const profile = extractProfileFromToken(token);
    const base = sessionJson && typeof sessionJson === 'object' ? { ...sessionJson } : {};
    const user = base.user || (profile.email || profile.userId ? {
        id: profile.userId || `user-${profile.accountId || 'session'}`,
        email: profile.email || undefined,
        name: profile.email || undefined
    } : null);

    const expires = base.expires
        || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    return {
        ...base,
        user,
        expires,
        accessToken: base.accessToken || base.access_token || token,
        authProvider: base.authProvider || 'google-oauth2'
    };
}

function parseSessionJson(raw) {
    const content = String(raw || '').trim();
    if (!content || !content.startsWith('{')) {
        return null;
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return data;
        }
    } catch (_) {
        return null;
    }
    return null;
}

const CHATGPT_COOKIE_URL = 'https://chatgpt.com';
const SESSION_TOKEN_BASE = '__Secure-next-auth.session-token';
/** 与 NextAuth SessionStore 一致：4096 - 160 */
const SESSION_COOKIE_CHUNK_SIZE = 3936;

function isSessionTokenCookieName(name) {
    return name === SESSION_TOKEN_BASE || name.startsWith(`${SESSION_TOKEN_BASE}.`);
}

/** 超长 sessionToken 按 NextAuth 规则拆成 .0 / .1 / … 多块 Cookie */
function expandSessionTokenCookies(value) {
    const token = sanitizeCookieValue(value);
    if (!token) {
        return [];
    }
    if (token.length <= SESSION_COOKIE_CHUNK_SIZE) {
        return [{ name: SESSION_TOKEN_BASE, value: token }];
    }
    const chunkCount = Math.ceil(token.length / SESSION_COOKIE_CHUNK_SIZE);
    const chunks = [];
    for (let i = 0; i < chunkCount; i++) {
        chunks.push({
            name: `${SESSION_TOKEN_BASE}.${i}`,
            value: token.substr(i * SESSION_COOKIE_CHUNK_SIZE, SESSION_COOKIE_CHUNK_SIZE)
        });
    }
    return chunks;
}

function hasStoredSessionToken(cookies) {
    return (cookies || []).some((item) => isSessionTokenCookieName(item.name));
}

function parseCookieHeader(header) {
    const pairs = [];
    for (const rawPart of String(header || '').split(';')) {
        const part = rawPart.trim();
        if (!part || !part.includes('=')) continue;
        const eq = part.indexOf('=');
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name && value) {
            pairs.push({ name, value });
        }
    }
    return pairs;
}

function isChatGptCookieDomain(domain) {
    const value = String(domain || '').toLowerCase();
    return !value || value.includes('chatgpt.com');
}

function normalizeSameSite(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'no_restriction' || value === 'none') {
        return 'None';
    }
    if (value === 'strict') {
        return 'Strict';
    }
    return 'Lax';
}

function sanitizeCookieValue(value) {
    return String(value || '')
        .replace(/^["']+|["']+$/g, '')
        .replace(/[\r\n\0]/g, '')
        .trim();
}

function isValidCookieName(name) {
    return /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/.test(name);
}

function toPlaywrightCookie(spec) {
    if (!spec || typeof spec !== 'object') {
        return null;
    }
    const name = String(spec.name || '').trim();
    const value = sanitizeCookieValue(spec.value);
    if (!name || !value || !isValidCookieName(name)) {
        return null;
    }

    const sameSite = normalizeSameSite(spec.sameSite);
    const secure = sameSite === 'None' || name.startsWith('__Host-') || name.startsWith('__Secure-')
        ? true
        : spec.secure !== false;
    const httpOnly = spec.httpOnly !== false;

    const base = { name, value, secure, httpOnly, sameSite };

    // __Host- / __Secure- 前缀：只能用 url，不能带 domain/path
    if (name.startsWith('__Host-') || name.startsWith('__Secure-')) {
        return { ...base, url: CHATGPT_COOKIE_URL };
    }

    const hostOnly = spec.hostOnly === true;
    const rawDomain = String(spec.domain || 'chatgpt.com').trim().toLowerCase() || 'chatgpt.com';
    const bareDomain = rawDomain.replace(/^\./, '');
    const domain = hostOnly ? bareDomain : (rawDomain.startsWith('.') ? rawDomain : `.${bareDomain}`);
    const path = String(spec.path || '/').trim() || '/';

    return { ...base, domain, path };
}

function toPlaywrightCookieFallback(cookie) {
    if (!cookie?.name || !cookie?.value) {
        return null;
    }
    const { name, value, secure, httpOnly, sameSite } = cookie;
    if (name.startsWith('__Host-')) {
        return { name, value, path: '/', secure: true, httpOnly, sameSite, url: CHATGPT_COOKIE_URL };
    }
    if (name.startsWith('__Secure-')) {
        return { name, value, domain: 'chatgpt.com', path: '/', secure: true, httpOnly, sameSite };
    }
    return null;
}

async function addCookieSafe(context, cookie) {
    try {
        await context.addCookies([cookie]);
        return null;
    } catch (primaryErr) {
        const fallback = toPlaywrightCookieFallback(cookie);
        if (!fallback) {
            return primaryErr.message;
        }
        try {
            await context.addCookies([fallback]);
            return null;
        } catch (fallbackErr) {
            return fallbackErr.message || primaryErr.message;
        }
    }
}

async function injectChatGptCookies(context, cookieSpecs) {
    if (!cookieSpecs.length) {
        return { injected: 0, hasSessionToken: false, failed: [] };
    }

    const warmup = await context.newPage();
    try {
        await warmup.goto(`${CHATGPT_COOKIE_URL}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
    } catch (_) { /* 代理慢时仍尝试写 Cookie */ }

    const playwrightCookies = cookieSpecs
        .map((spec) => toPlaywrightCookie(spec))
        .filter(Boolean);

    const failed = [];
    let injected = 0;
    for (const cookie of playwrightCookies) {
        const error = await addCookieSafe(context, cookie);
        if (error) {
            failed.push({ name: cookie.name, error });
            console.warn(`[Session] Cookie 注入跳过 ${cookie.name}: ${error}`);
            continue;
        }
        injected += 1;
    }

    if (failed.length) {
        console.warn(`[Session] ${failed.length}/${playwrightCookies.length} 个 Cookie 注入失败`);
    }

    const stored = await context.cookies(CHATGPT_COOKIE_URL);
    const hasSessionToken = hasStoredSessionToken(stored);
    await warmup.close().catch(() => {});

    return {
        injected,
        hasSessionToken,
        storedNames: stored.map((c) => c.name),
        failed
    };
}

// 将不同格式的 Session Cookie 转为后续浏览器注入所需的统一对象数组。
function collectCookieSpecs(sessionData, sessionJson) {
    // 保存最终结果；每项至少包含 Cookie 名称和 Cookie 值。
    const specs = [];
    // 保存“名称 + 值”的唯一标识，用于排除完全相同的 Cookie。
    const seen = new Set();
    // 单独保存名称，用于判断某个关键 Cookie 是否已存在。
    const seenNames = new Set();

    // 定义内部写入函数，统一完成清洗、去重和补充属性。
    const push = (name, value, extra = {}) => {
        // 将名称转为字符串并去除首尾空格；空值会变成空字符串。
        const n = String(name || '').trim();
        // 将值转为字符串并去除首尾空格；避免写入空 Cookie。
        const v = String(value || '').trim();
        // Cookie 名称或值为空时，该 Cookie 无法使用，直接跳过。
        if (!n || !v) return;
        // 使用空字符连接名称和值，生成不易冲突的去重键。
        const key = `${n}\0${v}`;
        // 已经收集过相同名称和值时，避免重复注入浏览器。
        if (seen.has(key)) return;
        // 记录本次 Cookie 的唯一键，供后续去重判断。
        seen.add(key);
        // 记录 Cookie 名称，供后续关键 Cookie 是否存在的判断使用。
        seenNames.add(n);
        // 将标准字段与额外属性合并后加入最终结果。
        specs.push({ name: n, value: v, ...extra });
    };

    // 依次尝试原始 JSON 和已解析 Session 中的完整 cookies 数组。
    for (const source of [sessionJson?.cookies, sessionData?.cookies]) {
        // 当前来源不是数组时无法遍历，跳到下一个来源。
        if (!Array.isArray(source)) continue;
        // 逐项读取来源中的完整 Cookie 对象。
        for (const item of source) {
            // 空值或非对象不是有效 Cookie 描述，直接跳过。
            if (!item || typeof item !== 'object') continue;
            // 提取并清洗 Cookie 名称。
            const name = String(item.name || '').trim();
            // 提取并清洗 Cookie 值。
            const value = String(item.value || '').trim();
            // 名称或值缺失的 Cookie 无法注入，直接跳过。
            if (!name || !value) continue;
            // 只接收 ChatGPT 域名的 Cookie，避免注入无关站点的数据。
            if (!isChatGptCookieDomain(item.domain)) continue;
            // 保留完整 Cookie 属性，使浏览器按原有作用域和安全策略写入。
            push(name, value, {
                // Cookie 生效的域名。
                domain: item.domain,
                // Cookie 生效的路径。
                path: item.path,
                // 是否仅允许 HTTPS 请求携带该 Cookie。
                secure: item.secure,
                // 是否禁止页面 JavaScript 直接读取该 Cookie。
                httpOnly: item.httpOnly,
                // 跨站请求时的携带策略。
                sameSite: item.sameSite,
                // 是否仅绑定当前主机而非所有子域名。
                hostOnly: item.hostOnly
            });
        }
    }

    // 依次读取 camelCase 与 snake_case 形式的 Cookie 请求头。
    for (const header of [
        sessionData?.cookieHeader,
        sessionData?.cookie_header,
        sessionJson?.cookieHeader,
        sessionJson?.cookie_header
    ]) {
        // 将“name=value; ...”请求头拆分为单个 Cookie 键值对。
        for (const pair of parseCookieHeader(header)) {
            // 请求头不含域名等属性，只写入名称和值。
            push(pair.name, pair.value);
        }
    }

    // 检查已收集的 Cookie 中是否已包含任意 session-token（包括分块名称）。
    const hasExportedSessionToken = [...seenNames].some((name) => isSessionTokenCookieName(name));

    // 按优先级从环境变量和 Session 字段读取会话令牌。
    const sessionToken = String(
        // 优先使用显式配置的完整 Session Cookie。
        process.env.CHATGPT_SESSION_COOKIE
        // 兼容旧环境变量名称。
        || process.env.CHATGPT_SESSION_TOKEN
        // 兼容 Session 中的 camelCase 字段。
        || sessionData?.sessionToken
        // 兼容 Session 中的 snake_case 字段。
        || sessionData?.session_token
        // 兼容直接以 Cookie 名为键保存的 Session 数据。
        || sessionData?.['__Secure-next-auth.session-token']
        // 所有来源都不存在时转为空字符串，便于统一调用 trim。
        || ''
    ).trim();

    // 只有拿到令牌且完整 Cookie 列表中尚未提供它时，才根据字段补齐。
    if (sessionToken && !hasExportedSessionToken) {
        // 将可能超长的 NextAuth 会话令牌拆成浏览器可识别的分块 Cookie。
        const chunks = expandSessionTokenCookies(sessionToken);
        // 多个分块意味着令牌长度超出单个 Cookie 的常见限制，记录诊断日志。
        if (chunks.length > 1) {
            console.log(`[Session] session-token 长度 ${sessionToken.length}，按 NextAuth 分 ${chunks.length} 块注入`);
        }
        // 逐个添加拆分后的 session-token Cookie。
        for (const chunk of chunks) {
            push(chunk.name, chunk.value);
        }
    }

    // 从 Session 的多种字段命名中读取 CSRF 令牌。
    const csrfToken = String(
        // 优先使用 camelCase 字段。
        sessionData?.csrfToken
        // 兼容 snake_case 字段。
        || sessionData?.csrf_token
        // 兼容以实际 Cookie 名为键保存的字段。
        || sessionData?.['__Host-next-auth.csrf-token']
        // 缺失时使用空字符串，避免 String(undefined) 变成字符串 "undefined"。
        || ''
    ).trim();
    // CSRF 令牌存在且尚未由 cookies 或请求头提供时，补齐对应 Cookie。
    if (csrfToken && !seenNames.has('__Host-next-auth.csrf-token')) {
        push('__Host-next-auth.csrf-token', csrfToken);
    }

    // 从 Session 的多种字段命名中读取 OpenAI 设备标识。
    const deviceId = String(sessionData?.deviceId || sessionData?.device_id || sessionData?.['oai-did'] || '').trim();
    // 设备标识存在且尚未收集时，补齐 oai-did Cookie。
    if (deviceId && !seenNames.has('oai-did')) {
        push('oai-did', deviceId);
    }

    // 返回已清洗、去重并补齐后的 Cookie 规格列表。
    return specs;
}

async function verifyRealSessionApi(context) {
    const probe = await context.newPage();
    try {
        const response = await probe.goto(`${CHATGPT_COOKIE_URL}/api/auth/session`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        const status = response?.status() || 0;
        const headers = response?.headers?.() || {};
        const headerText = Object.keys(headers).map((k) => `${k}:${headers[k]}`).join('\n').toLowerCase();
        const bodyText = await probe.evaluate(() => document.body?.innerText || '').catch(() => '');
        let data = null;
        try {
            data = JSON.parse(bodyText);
        } catch (_) {
            data = null;
        }
        if (data?.accessToken || data?.user?.email || data?.user?.id) {
            return { ok: true, data, status };
        }
        const isCloudflareChallenge = headerText.includes('cf-mitigated: challenge')
            || /just a moment|verify you are human/i.test(bodyText);
        if (isCloudflareChallenge) {
            return {
                ok: false,
                status,
                challenge: true,
                error: `Cloudflare 人机验证拦截（HTTP ${status}，cf-mitigated: challenge）`
                    + '。当前出口/代理 IP 被 ChatGPT 风控，请更换干净的住宅代理后重试'
            };
        }
        const snippet = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 120);
        return {
            ok: false,
            status,
            error: `session-token 未被 ChatGPT 接受（/api/auth/session 无用户信息，HTTP ${status}${snippet ? `，响应: ${snippet}` : ''}）`
        };
    } catch (err) {
        return { ok: false, error: `无法验证 session Cookie: ${err.message}` };
    } finally {
        await probe.close().catch(() => {});
    }
}

function extractAccessTokenFromRaw(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return '';
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        return String(sessionJson.accessToken || sessionJson.access_token || '').trim();
    }

    const jwtMatch = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwtMatch) {
        return jwtMatch[0];
    }

    return content;
}

/**
 * 统一解析用户输入：优先完整 Session JSON，其次裸 AccessToken
 */
function resolveSessionInput(raw) {
    const content = String(raw || '').trim();
    if (!content) {
        return null;
    }

    const sessionJson = parseSessionJson(content);
    if (sessionJson) {
        const accessToken = extractAccessTokenFromRaw(content);
        if (!accessToken) {
            return null;
        }
        return {
            accessToken,
            sessionJson,
            sessionData: buildSessionPayload(accessToken, sessionJson),
            rawJson: JSON.stringify(sessionJson)
        };
    }

    const accessToken = extractAccessTokenFromRaw(content);
    if (!accessToken) {
        return null;
    }

    const sessionData = buildSessionPayload(accessToken, null);
    return {
        accessToken,
        sessionJson: null,
        sessionData,
        rawJson: JSON.stringify(sessionData)
    };
}

async function assertChatGptLoggedIn(page, label = '页面') {
    const url = page.url();
    if (isLoginRedirectUrl(url)) {
        throw new Error(`Session 未生效：${label} 跳转到 Google/登录页 (${url.slice(0, 80)})`);
    }
    if (await isLoginPageContent(page)) {
        throw new Error(`Session 未生效：${label} 显示 Google 登录界面，请粘贴完整 Session JSON`);
    }
}

function attachLoginRedirectGuard(page) {
    page.on('framenavigated', async (frame) => {
        if (frame !== page.mainFrame() || page.isClosed()) {
            return;
        }
        const url = frame.url();
        const current = page.url();
        if (isCheckoutPageUrl(current) || isCheckoutPageUrl(url)) {
            return;
        }
        if (!isHardLoginRedirectUrl(url)) {
            return;
        }
        console.warn(`[Warn] 检测到登录页跳转，正在拉回 ChatGPT: ${url.slice(0, 80)}`);
        await page.goto(`${CHATGPT_ORIGIN}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        }).catch(() => {});
    });
}

/**
 * 在浏览器上下文安装 Session：拦截 auth API + 注入 fetch 补丁
 * 注意：__Secure-next-auth.session-token 是加密 cookie，不能用 accessToken 冒充
 */
async function installChatGptSession(context, sessionRaw) {
    const resolved = resolveSessionInput(sessionRaw);
    if (!resolved?.accessToken) {
        throw new Error('缺少 Session：请粘贴完整 Session JSON（来自 chatgpt.com/api/auth/session）');
    }

    const { accessToken: token, sessionData, sessionJson } = resolved;
    const sessionBody = JSON.stringify(sessionData);
    const cookieSpecs = collectCookieSpecs(sessionData, sessionJson);

    const sessionTokenValue = String(
        process.env.CHATGPT_SESSION_COOKIE
        || process.env.CHATGPT_SESSION_TOKEN
        || sessionData?.sessionToken
        || sessionData?.session_token
        || sessionData?.['__Secure-next-auth.session-token']
        || cookieSpecs.find((c) => c.name === SESSION_TOKEN_BASE)?.value
        || ''
    ).trim();

    if (sessionTokenValue && sessionTokenValue === token) {
        throw new Error(
            'sessionToken 与 accessToken 相同：请从浏览器 DevTools → Application → Cookies 复制 '
            + '__Secure-next-auth.session-token（不是 /api/auth/session JSON 里的 accessToken）'
        );
    }

    const injectResult = await injectChatGptCookies(context, cookieSpecs);

    const sessionTokenFailed = injectResult.failed?.filter((item) => isSessionTokenCookieName(item.name)) || [];

    if (sessionTokenValue && sessionTokenFailed.length) {
        throw new Error(
            `session-token Cookie 注入失败: ${sessionTokenFailed.map((item) => `${item.name}(${item.error})`).join('; ')}`
        );
    }

    if (!injectResult.hasSessionToken) {
        console.warn('[Session] 未提供 session-token Cookie，Checkout 会停留在登录页；'
            + '请导出 __Secure-next-auth.session-token，或粘贴完整 cookies[] / cookieHeader');
    } else {
        console.log(
            `[Session] 已注入 ${injectResult.injected} 个 Cookie（session-token ${sessionTokenValue ? `${sessionTokenValue.length} 字符` : '来自 cookies[]'}）`
        );
    }

    let cookieVerified = false;
    if (injectResult.hasSessionToken) {
        const apiCheck = await verifyRealSessionApi(context);
        if (apiCheck.ok) {
            cookieVerified = true;
            const email = apiCheck.data?.user?.email || '';
            console.log(`[Session] Cookie 校验通过${email ? `: ${email}` : ''}`);
        } else if (apiCheck.error && !/cloudflare|challenge|captcha/i.test(apiCheck.error)) {
            throw new Error(
                `${apiCheck.error}。请确认 Cookie 未过期，并尽量粘贴浏览器全部 chatgpt.com Cookies（cookies[] 或 cookieHeader）`
            );
        } else {
            console.warn(`[Session] Cookie 在线校验跳过: ${apiCheck.error || 'unknown'}`);
        }
    }

    await context.addInitScript((payload) => {
        const sessionStr = JSON.stringify(payload);
        try {
            window.__CHATGPT_BOOTSTRAP_SESSION__ = payload;
            localStorage.setItem('oai/apps/chat/bootstrap-session', sessionStr);
        } catch (_) { /* ignore */ }

        const originalFetch = window.fetch.bind(window);
        window.fetch = async function patchedFetch(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('/api/auth/session')) {
                return new Response(sessionStr, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (url.includes('/api/auth/csrf')) {
                return new Response(JSON.stringify({ csrfToken: 'bootstrap-csrf-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return originalFetch(input, init);
        };
    }, sessionData);

    await context.route(/\/api\/auth\/session(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: sessionBody
        });
    });

    await context.route(/\/api\/auth\/csrf(\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ csrfToken: 'bootstrap-csrf-token' })
        });
    });

    await context.route('**/*', async (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();
        if (shouldBlockLoginNavigation(url, resourceType)) {
            await route.abort();
            return;
        }
        if (/\/api\/auth\/(session|csrf)/.test(url)) {
            await route.continue();
            return;
        }
        if (url.includes('auth.openai.com') || url.includes('chatgpt.com') || url.includes('openai.com') || url.includes('pay.openai.com')) {
            await route.continue({
                headers: {
                    ...route.request().headers(),
                    Authorization: `Bearer ${token}`
                }
            });
            return;
        }
        await route.continue();
    });

    return { sessionData, cookieVerified };
}

/**
 * @deprecated 使用 installChatGptSession(context, sessionRaw)
 */
function setupChatGptSessionAuth(context, accessToken) {
    return installChatGptSession(context, accessToken);
}

/**
 * 打开 ChatGPT 并验证 Session 在浏览器 UI 中生效
 */
async function bootstrapChatGptSession(page, sessionRaw, options = {}) {
    const resolved = resolveSessionInput(sessionRaw);
    if (!resolved?.accessToken) {
        throw new Error('缺少 Session：请粘贴完整 Session JSON');
    }

    const sessionData = options.sessionData || resolved.sessionData;
    const email = sessionData?.user?.email || extractProfileFromToken(resolved.accessToken).email || '';

    if (!email && !sessionData?.user?.id) {
        throw new Error('Session 无效：JSON 中缺少 user 信息，请从 chatgpt.com/api/auth/session 复制完整内容');
    }

    console.log('🔐 [步骤] 正在使用 Session 登录 ChatGPT...');
    attachLoginRedirectGuard(page);

    await page.goto(`${CHATGPT_ORIGIN}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
    });
    await page.waitForTimeout(2500);

    const { clearHumanVerification } = require('./human-verification');
    const captchaResult = await clearHumanVerification(page, {
        phase: 'session-bootstrap',
        maxWaitMs: Number(process.env.CAPTCHA_CLEAR_TIMEOUT_MS || 180000),
        maxBypassRounds: 6
    });
    if (!captchaResult.cleared) {
        throw new Error('Cloudflare 人机验证未能通过，请换住宅代理 IP 或 HEADFUL=1 人工勾选');
    }

    if (await hasVisibleLoginChrome(page)) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await page.waitForTimeout(2000);
    }

    await assertChatGptLoggedIn(page, '首页');

    const cookieVerified = options.cookieVerified === true;
    const uiReady = await waitForLoggedInChatUi(page, cookieVerified ? 12000 : 8000);
    const apiReady = cookieVerified ? await hasLoggedInSessionApi(page) : false;

    if (await hasVisibleLoginChrome(page)) {
        throw new Error(buildSessionNotLoggedInError('ChatGPT 首页'));
    }
    if (!uiReady && !apiReady) {
        throw new Error(buildSessionNotLoggedInError('ChatGPT 首页'));
    }
    if (!uiReady && apiReady) {
        console.log('[Session] 首页 UI 探针未命中，但 /api/auth/session 已确认登录，继续流程');
    }

    const resolvedEmail = sessionData?.user?.email || email || extractProfileFromToken(resolved.accessToken).email;
    console.log(`✅ [步骤] Session 登录成功: ${resolvedEmail}`);
    return {
        email: resolvedEmail,
        session: sessionData,
        hasSessionCookie: Boolean(
            process.env.CHATGPT_SESSION_COOKIE
            || process.env.CHATGPT_SESSION_TOKEN
            || sessionData.sessionToken
            || sessionData.session_token
            || sessionData['__Secure-next-auth.session-token']
            || (Array.isArray(sessionData.cookies) && sessionData.cookies.length > 0)
            || sessionData.cookieHeader
            || sessionData.cookie_header
        )
    };
}

function extractSessionPreview(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return String(raw || '').slice(0, 32);
    }
    const email = resolved.sessionData?.user?.email;
    if (email) {
        return email;
    }
    return `${resolved.accessToken.slice(0, 12)}...`;
}

function extractEmailFromSession(raw) {
    const resolved = resolveSessionInput(raw);
    if (!resolved) {
        return '';
    }
    return String(
        resolved.sessionData?.user?.email
        || resolved.sessionJson?.user?.email
        || extractProfileFromToken(resolved.accessToken).email
        || ''
    ).trim();
}

module.exports = {
    CHATGPT_ORIGIN,
    installChatGptSession,
    setupChatGptSessionAuth,
    bootstrapChatGptSession,
    assertChatGptLoggedIn,
    parseSessionJson,
    resolveSessionInput,
    extractAccessTokenFromRaw,
    extractProfileFromToken,
    extractSessionPreview,
    extractEmailFromSession,
    buildSessionPayload,
    isLoginRedirectUrl,
    isHardLoginRedirectUrl,
    isCheckoutPageUrl,
    isLoginPageContent
};
