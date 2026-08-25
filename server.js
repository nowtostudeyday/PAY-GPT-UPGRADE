const express = require('express');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const axios = require('axios');
const store = require('./mysql-store');
const runtimeLog = require('./runtime-log');
const { REGION_CONFIG, isSupportedRegion, getPlanTypeLabel } = require('./region-config');
const taxFreeAddress = require('./tax-free-address');
const { testProxyUrl, normalizeProxyLines } = require('./proxy-pool');
const { extractSessionPreview, extractAccessTokenFromRaw, parseSessionJson, extractEmailFromSession } = require('./session-auth');
const { notifyTelegramEvent, notifyAdminSecurityEvent, sendTelegramLoginCode, sendTelegramTest, isCardPoolExhaustedIssue } = require('./telegram-notify');
const adminAuth = require('./admin-auth');
const { buildAdminLoginUrl, buildAdminPanelUrl } = require('./admin-paths');
const { buildHcaptchaEnvFromConfig } = require('./hcaptcha-runtime');
const { checkHcaptchaSolverHealth, testVlmConnectivity, listSolverLogFiles, readSolverLogTail } = require('./hcaptcha-solver');
const { testCaptchaPlatformConnectivity, normalizeCaptchaPlatformApiUrl, resolveCaptchaPlatformCredentials } = require('./captcha-platform');
const browserPool = require('./browser-pool');
const { buildWorkerRuntimeEnv } = require('./browser-runtime');
const { querySubscriptionBySession, validateSessionTokenForQuery, cancelAutoRenew, resumeAutoRenew } = require('./subscription-check');
const gptApi = require('./gpt-api-client');
const { isPaymentDeclined } = require('./payment-retry');
const {
    CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT,
    verifyCardSupplierWebhook,
    decryptCardSupplierIssuedCards
} = require('./card-supplier-webhook');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN_TTL_MS = adminAuth.ADMIN_TOKEN_TTL_MS;
const ADMIN_REFRESH_AFTER_MS = adminAuth.ADMIN_REFRESH_AFTER_MS;
const PROCESS_IDLE_TIMEOUT_MS = Number(process.env.PROCESS_IDLE_TIMEOUT_MS) || (3 * 60 * 1000);
const MAX_PROCESS_ATTEMPTS = Number(process.env.MAX_PROCESS_ATTEMPTS) || 1;
const WS_HEARTBEAT_PING_TYPE = 'ping';
const WS_HEARTBEAT_PONG_TYPE = 'pong';
const ACCESS_DEACTIVATED_MESSAGES_URL = '';
const ACCESS_DEACTIVATED_SYNC_KEY = '';
const ACCESS_DEACTIVATED_SYNC_COOLDOWN_MS = 30 * 1000;
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || adminAuth.resolveAdminTokenSecret();

// 追踪活跃的子进程，防止产生僵尸进程
const activeProcesses = new Set();
function cleanupProcesses() {
    if (activeProcesses.size > 0) {
        console.log(`清理 ${activeProcesses.size} 个活跃子进程...`);
        for (const child of activeProcesses) {
            try { child.kill('SIGKILL'); } catch (e) { }
        }
        activeProcesses.clear();
    }
    browserPool.shutdownBrowserPool().catch((error) => {
        console.warn(`[BrowserPool] 关闭失败: ${error.message}`);
    });
}

// WebSocket 客户端映射: jobKey -> Set<WebSocket>
const taskClients = new Map();
const TERMINAL_TASK_STATUSES = new Set(['success', 'failed', 'maintenance']);
const activeForegroundJobs = new Set();

let systemMetricsCache = {
    ts: 0,
    data: null,
    promise: null
};

function reserveForegroundSlot(slotKey) {
    activeForegroundJobs.add(String(slotKey));
}

function releaseForegroundSlot(slotKey) {
    activeForegroundJobs.delete(String(slotKey));
}

function getTotalActiveJobs() {
    return activeForegroundJobs.size;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSystemMetrics() {
    const now = Date.now();
    if (systemMetricsCache.data && now - systemMetricsCache.ts < 3000) {
        return systemMetricsCache.data;
    }
    if (systemMetricsCache.promise) {
        return systemMetricsCache.promise;
    }

    systemMetricsCache.promise = (async () => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const cpuCount = Math.max(1, (os.cpus() || []).length);
        const load = Number(os.loadavg()[0] || 0);
        const cpuPercent = Math.min(100, Math.round((load / cpuCount) * 100));

        let disk = {
            percent: 0,
            usedText: '0.0G',
            totalText: '0.0G',
            drive: '/'
        };
        try {
            const dfOut = execFileSync('df', ['-kP', '/'], { encoding: 'utf8' });
            const lines = dfOut.trim().split('\n');
            if (lines.length >= 2) {
                const parts = lines[1].trim().split(/\s+/);
                const total = Number(parts[1] || 0) * 1024;
                const used = Number(parts[2] || 0) * 1024;
                disk = {
                    percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
                    usedText: `${(used / (1024 ** 3)).toFixed(1)}G`,
                    totalText: `${(total / (1024 ** 3)).toFixed(1)}G`,
                    drive: parts[5] || '/'
                };
            }
        } catch (_) { /* ignore */ }

        const data = {
            cpu: {
                percent: cpuPercent,
                text: `负载 ${load.toFixed(2)} / ${cpuCount} 核`
            },
            memory: {
                percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
                text: `${(usedMem / (1024 ** 3)).toFixed(1)}G/${(totalMem / (1024 ** 3)).toFixed(1)}G`
            },
            disk,
            uptime: { seconds: Math.floor(os.uptime()) }
        };
        systemMetricsCache.data = data;
        systemMetricsCache.ts = Date.now();
        systemMetricsCache.promise = null;
        return data;
    })().catch((error) => {
        systemMetricsCache.promise = null;
        throw error;
    });

    return systemMetricsCache.promise;
}

function getClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').trim();
    const rawIp = forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || '');
    return String(rawIp || '')
        .replace(/^::ffff:/, '')
        .replace(/^::1$/, '127.0.0.1')
        .trim();
}

function getRemainingCooldownMinutes(cooldownUntil) {
    if (!cooldownUntil) {
        return 0;
    }
    const cooldownDate = new Date(cooldownUntil);
    if (!(cooldownDate instanceof Date) || Number.isNaN(cooldownDate.getTime()) || cooldownDate <= new Date()) {
        return 0;
    }
    return Math.ceil((cooldownDate - new Date()) / 60000);
}

function isNoActivationEligibilityMessage(message) {
    return String(message || '').includes('无激活权限');
}

function parseFlexibleTimestamp(value) {
    if (value == null || value === '') {
        return null;
    }

    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value > 1e12) {
            return Math.trunc(value);
        }
        if (value > 1e9) {
            return Math.trunc(value * 1000);
        }
        return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }

    if (/^\d{13}$/.test(normalized)) {
        return Number(normalized);
    }
    if (/^\d{10}$/.test(normalized)) {
        return Number(normalized) * 1000;
    }

    const candidate = normalized.includes('T')
        ? normalized
        : normalized.replace(' ', 'T');
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
        return parsed;
    }

    return null;
}


function broadcastToTask(jobKey, data) {
    const clients = taskClients.get(jobKey);
    if (clients) {
        const message = JSON.stringify(data);
        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }
}

function unsubscribeTaskClient(jobKey, ws) {
    if (!jobKey || !taskClients.has(jobKey)) {
        return;
    }
    const clients = taskClients.get(jobKey);
    clients.delete(ws);
    if (clients.size === 0) {
        taskClients.delete(jobKey);
    }
}

async function sendTaskSnapshot(ws, jobKey) {
    const task = await store.getTaskStatus(jobKey);
    if (!task || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    let storedMedia = { screenshots: [], videos: [] };
    if (task.failure_screenshots) {
        try {
            const parsed = JSON.parse(task.failure_screenshots);
            storedMedia = splitTaskMediaPaths(Array.isArray(parsed) ? parsed : []);
        } catch (_) { /* ignore */ }
    }
    const media = extractTaskMediaFromOutput(task.raw_output || '');

    ws.send(JSON.stringify({
        type: 'snapshot',
        jobKey,
        status: task.status,
        message: task.message,
        progress: Number(task.progress || 0),
        cdkCode: task.cdk_code || null,
        phone: task.phone || null,
        cardLast4: task.card_last4 || null,
        screenshots: [...new Set([...storedMedia.screenshots, ...media.screenshots])],
        videos: [...new Set([...storedMedia.videos, ...media.videos])],
        isTerminal: TERMINAL_TASK_STATUSES.has(task.status)
    }));
}

function logTask(jobKey, message, level = 'log') {
    runtimeLog.push({
        jobKey,
        level,
        source: 'task',
        text: String(message || '')
    });
    const logger = console[level] || console.log;
    logger(`[Task ${jobKey}] ${message}`);
}

function logTaskChunk(jobKey, attempt, source, chunk) {
    const text = String(chunk || '');
    if (!text) {
        return;
    }

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        runtimeLog.push({
            jobKey,
            level: line.includes('CAPTCHA_LOG:') || line.includes('[Captcha/')
                ? 'captcha'
                : (source === 'stderr' ? 'stderr' : 'stdout'),
            source: line.includes('CAPTCHA_LOG:') || line.includes('[Captcha/')
                ? 'captcha'
                : `spawn/a${attempt}/${source}`,
            text: line.replace(/^CAPTCHA_LOG:\s*/, '')
        });
        console.log(`[Task ${jobKey}][Attempt ${attempt}][${source}] ${line}`);
    }
}

process.on('SIGINT', () => { cleanupProcesses(); process.exit(0); });
process.on('SIGTERM', () => { cleanupProcesses(); process.exit(0); });
process.on('exit', () => cleanupProcesses());

let storeReadyPromise = null;

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '15mb';
const sendCardSupplierWebhookOk = (res) => res.status(200).type('text/plain').send('ok');

app.post('/api/webhooks/card-issue', express.raw({ type: 'application/json', limit: JSON_BODY_LIMIT }), async (req, res) => {
    const rawBody = req.body;
    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
        return res.status(400).type('text/plain').send('Webhook JSON 格式无效');
    }

    try {
        await ensureStoreReady();
        const cardSupplierConfig = await store.getCardSupplierWebhookConfig();
        const webhookSecret = cardSupplierConfig.webhook_secret;
        if (!webhookSecret) {
            return res.status(503).type('text/plain').send('卡片供应商 Webhook 未配置');
        }
        const verification = verifyCardSupplierWebhook({
            headers: req.headers,
            payload,
            rawBody,
            webhookSecret
        });
        if (!verification.valid) {
            return res.status(401).type('text/plain').send('Webhook 签名校验失败');
        }
        if (verification.eventType !== CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT) {
            await store.acknowledgeCardSupplierWebhookEvent(verification);
            return sendCardSupplierWebhookOk(res);
        }

        const cards = decryptCardSupplierIssuedCards(payload, webhookSecret);
        await store.importCardSupplierCardIssueEvent({ ...verification, cards });
        return sendCardSupplierWebhookOk(res);
    } catch (error) {
        console.warn(`[卡片供应商 Webhook] 处理失败: ${error.message}`);
        return res.status(500).type('text/plain').send('Webhook 处理失败');
    }
});

app.use(express.json({ limit: JSON_BODY_LIMIT }));

let cachedAdminPaths = null;

async function getCachedAdminPaths() {
    if (cachedAdminPaths) {
        return cachedAdminPaths;
    }
    await ensureStoreReady();
    cachedAdminPaths = await store.getAdminPaths();
    return cachedAdminPaths;
}

function invalidateAdminPathsCache() {
    cachedAdminPaths = null;
}

function normalizeRequestPathname(pathname) {
    return String(pathname || '/').replace(/\/+$/, '') || '/';
}

async function attachAdminPaths(payload) {
    const paths = await getCachedAdminPaths();
    return {
        ...payload,
        loginPath: buildAdminLoginUrl(paths),
        panelPath: buildAdminPanelUrl(paths)
    };
}

app.use((req, res, next) => {
    if (req.method === 'GET' && ['/admin.html', '/admin-login.html'].includes(req.path)) {
        return res.status(404).type('text/plain').send('Not Found');
    }
    next();
});

app.use(async (req, res, next) => {
    if (req.method !== 'GET') {
        return next();
    }
    try {
        const paths = await getCachedAdminPaths();
        const current = normalizeRequestPathname(req.path);
        const loginUrl = normalizeRequestPathname(buildAdminLoginUrl(paths));
        const panelUrl = normalizeRequestPathname(buildAdminPanelUrl(paths));
        if (current === loginUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
        }
        if (current === panelUrl) {
            return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
        }
    } catch (_) {
        // DB 尚未就绪时交给后续路由处理
    }
    return next();
});

app.use(express.static(path.join(__dirname, 'public')));

function ensureStoreReady() {
    if (!storeReadyPromise) {
        storeReadyPromise = store.ensureReady().then(async () => {
            await store.initializeCardSupplierWebhookConfig(process.env.CARD_SUPPLIER_WEBHOOK_SECRET);
        }).catch((error) => {
            storeReadyPromise = null;
            throw error;
        });
    }
    return storeReadyPromise;
}

function decodeJwtPart(part) {
    const normalized = String(part || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function normalizeSessionToken(raw) {
    return extractAccessTokenFromRaw(raw);
}

function normalizeSessionRaw(raw) {
    const content = String(raw || '').trim();
    if (!content.startsWith('{')) {
        return '';
    }
    try {
        const data = JSON.parse(content);
        if (data?.accessToken || data?.access_token || data?.user) {
            return content;
        }
    } catch (_) {
        return '';
    }
    return '';
}

function buildStoredSessionPayload(rawSession, sessionJson, token) {
    if (sessionJson) {
        return normalizeSessionRaw(rawSession) || JSON.stringify(sessionJson);
    }
    if (rawSession.startsWith('{')) {
        return rawSession;
    }
    if (token) {
        return JSON.stringify({
            accessToken: token,
            user: null,
            expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
    }
    return rawSession;
}

function validateAccessToken(token) {
    const value = String(token || '').trim();
    if (!value) {
        return { valid: false, message: '缺少 AccessToken' };
    }

    const parts = value.split('.');
    if (parts.length !== 3 || parts.some((item) => !item)) {
        return { valid: false, message: '该 Token 不合法：格式错误' };
    }

    let header;
    let payload;
    try {
        header = decodeJwtPart(parts[0]);
        payload = decodeJwtPart(parts[1]);
    } catch (_) {
        return { valid: false, message: '该 Token 不合法：无法解析' };
    }

    if (header.typ !== 'JWT') {
        return { valid: false, message: '该 Token 不合法：类型错误' };
    }

    if (header.alg !== 'RS256') {
        return { valid: false, message: '该 Token 不合法：算法错误' };
    }

    if (payload.iss !== 'https://auth.openai.com') {
        return { valid: false, message: '该 Token 不合法：签发方错误' };
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
    if (!audiences.includes('https://api.openai.com/v1')) {
        return { valid: false, message: '该 Token 不合法：aud 不匹配' };
    }

    const authInfo = payload['https://api.openai.com/auth'];
    if (!authInfo || !authInfo.chatgpt_account_id || !authInfo.chatgpt_user_id) {
        return { valid: false, message: '该 Token 不合法：缺少账户信息' };
    }

    const scopes = Array.isArray(payload.scp) ? payload.scp : [];
    if (!scopes.includes('model.request')) {
        return { valid: false, message: '该 Token 不合法：缺少 model.request 权限' };
    }

    const exp = Number(payload.exp || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!exp || !Number.isFinite(exp)) {
        return { valid: false, message: '该 Token 不合法：缺少过期时间' };
    }
    if (exp <= now) {
        return { valid: false, message: '该 Token 已过期' };
    }

    return { valid: true };
}

const verifyPassword = adminAuth.verifyPassword;
const issueAdminToken = adminAuth.issueAdminToken;
const verifyAdminToken = adminAuth.verifyAdminToken;
const requireSecondaryAuth = adminAuth.createRequireSecondaryAuth(store, ensureStoreReady);

async function logAdminSecurityEvent(event, meta = {}) {
    try {
        await ensureStoreReady();
        await store.insertAdminLoginLog({
            event,
            adminEmail: meta.email || '',
            ip: meta.ip || '',
            userAgent: meta.userAgent || '',
            fingerprint: meta.fingerprint || '',
            detail: meta.detail || ''
        });
    } catch (error) {
        console.warn(`[AdminAuth] 登录日志写入失败: ${error.message}`);
    }
}

async function fireAdminSecurityNotification(event, payload = {}) {
    notifyAdminSecurityEvent(store, event, payload).catch((error) => {
        console.warn(`[AdminAuth] Telegram 通知失败: ${error.message}`);
    });
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme === 'Bearer' && token) {
        return token.trim();
    }
    return (req.query?.token || '').trim() || null;
}

async function authenticateAdmin(req, res, next) {
    const token = getBearerToken(req);
    const payload = verifyAdminToken(token);
    if (!payload) {
        return res.status(401).json({ success: false, message: '未授权，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (Number(payload.pv || 0) !== authConfig.passwordVersion) {
            return res.status(401).json({ success: false, message: '登录状态已失效，请重新登录' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    req.admin = payload;
    req.adminToken = token;
    return next();
}

const CDK_PREFIX = 'KC-';
const CDK_RANDOM_LENGTH = 15; // KC- + 15 = 18 位
const CDK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆 0/O/1/I/L

function randomCdkSuffix(length = CDK_RANDOM_LENGTH) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += CDK_CHARSET[bytes[i] % CDK_CHARSET.length];
    }
    return out;
}

function createCdks(count) {
    const results = new Set();
    const target = Math.max(1, Math.min(Number(count) || 1, 100));

    while (results.size < target) {
        results.add(`${CDK_PREFIX}${randomCdkSuffix()}`);
    }

    return [...results];
}

function extractScreenshotsFromOutput(output) {
    const paths = new Set();
    const text = String(output || '');
    const patterns = [
        /FAILURE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /SUCCESS_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /LIVE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /截图已保存:\s*([^\s\n]+\.png)/g
    ];
    for (const pattern of patterns) {
        let match = pattern.exec(text);
        while (match) {
            paths.add(match[1]);
            match = pattern.exec(text);
        }
    }
    return normalizeMediaPaths([...paths]);
}

function extractVideosFromOutput(output) {
    const paths = new Set();
    const text = String(output || '');
    const pattern = /VIDEO_FILE:\s*([^\s\n]+\.webm)/g;
    let match = pattern.exec(text);
    while (match) {
        paths.add(match[1]);
        match = pattern.exec(text);
    }
    return normalizeMediaPaths([...paths]);
}

function normalizeMediaPaths(paths) {
    return paths.map((filePath) => {
        const normalized = String(filePath).replace(/\\/g, '/');
        const marker = 'debug_screenshots/';
        const idx = normalized.indexOf(marker);
        if (idx >= 0) {
            return normalized.slice(idx + marker.length);
        }
        return path.basename(normalized);
    });
}

function extractTaskMediaFromOutput(output) {
    return {
        screenshots: extractScreenshotsFromOutput(output),
        videos: extractVideosFromOutput(output)
    };
}

function splitTaskMediaPaths(items) {
    const list = Array.isArray(items) ? items : [];
    const screenshots = [];
    const videos = [];
    for (const item of list) {
        const rel = String(item || '').replace(/\\/g, '/');
        if (!rel) continue;
        if (/\.webm$/i.test(rel)) {
            videos.push(rel);
        } else {
            screenshots.push(rel);
        }
    }
    return { screenshots, videos };
}

function extractCheckoutUrlFromOutput(output) {
    const match = String(output || '').match(/CHECKOUT_URL:\s*(https?\S+)/);
    return match ? match[1].trim() : '';
}

function analyzeCheckoutDebugOutput(output, timedOut) {
    const normalized = String(output || '');
    const runtimeError = extractRuntimeErrorMessage(normalized);

    if (normalized.includes('CHECKOUT_DEBUG_SUCCESS')) {
        const checkoutUrl = extractCheckoutUrlFromOutput(normalized);
        return {
            status: 'success',
            message: checkoutUrl ? `支付链接已生成: ${checkoutUrl}` : '支付链接调试成功',
            checkoutUrl,
            reachedPayment: Boolean(checkoutUrl),
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    const base = analyzeProcessOutput(output, timedOut);
    if (base.status === 'retry') {
        return {
            ...base,
            status: 'failed',
            message: String(base.message || runtimeError || '支付链接调试失败').replace('，准备重试', '')
        };
    }
    if (base.status === 'success') {
        return {
            status: 'failed',
            message: runtimeError || '调试流程异常结束（未输出 CHECKOUT_DEBUG_SUCCESS）',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }
    return base;
}

function extractCardLast4FromOutput(output) {
    const text = String(output || '');
    const reserved = text.match(/已预留卡片:\s*\.\.\.(\d{4})/);
    if (reserved) {
        return reserved[1];
    }
    const attempt = text.match(/ATTEMPT \d+ \| CARD (\d{4})/);
    if (attempt) {
        return attempt[1];
    }
    return null;
}

function buildRuntimeFailure(message, code, status = 'failed', extra = {}) {
    return {
        success: false,
        message,
        code,
        status,
        ...extra
    };
}

function extractRuntimeErrorMessage(output) {
    const normalized = String(output || '');
    const match = normalized.match(/❌ \[运行时错误\]:\s*(.+)/);
    if (match) {
        return match[1].trim();
    }
    const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].startsWith('Error:')) {
            return lines[i].replace(/^Error:\s*/, '');
        }
    }
    return '';
}

function analyzeProcessOutput(output, timedOut) {
    const normalized = String(output || '');
    const runtimeError = extractRuntimeErrorMessage(normalized);
    const reachedPayment = normalized.includes('[Stripe] Step')
        || normalized.includes('正在使用 Stripe 信用卡')
        || normalized.includes('Checkout 页面已打开')
        || normalized.includes('chatgpt.com/checkout')
        || normalized.includes('配置套餐')
        || normalized.includes('定价页')
        || normalized.includes('#pricing');
    const success = normalized.includes('PAYMENT_SUCCESS') || normalized.includes('最终校验：支付成功') || normalized.includes('支付成功');

    if (normalized.includes('PAID_PLAN_MISMATCH')) {
        return {
            status: 'manual',
            message: '已扣款，但实际订阅套餐与请求套餐不一致；CDK 已保留，请人工核验后处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false,
            retainCdk: true
        };
    }

    if (success) {
        return {
            status: 'success',
            message: '激活成功',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('金额校验失败')) {
        return {
            status: 'failed',
            message: '支付金额校验失败，请检查账单地区与币种配置',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Session 未生效')
        || normalized.includes('Google 登录')
        || normalized.includes('Sign in with Google')) {
        return {
            status: 'failed',
            message: runtimeError || 'Session 未在浏览器中生效，请粘贴完整 Session JSON（从 chatgpt.com/api/auth/session 全选复制）',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Session 无效')
        || normalized.includes('Session 登录失败')
        || normalized.includes('Session 响应异常')
        || normalized.includes('缺少 AccessToken')) {
        return {
            status: 'failed',
            message: runtimeError || 'Session 无效或已过期，请重新获取完整 Session JSON 后重试',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('无法将定价页切换到目标地区')) {
        return {
            status: 'failed',
            message: runtimeError || '定价页地区切换失败，已尝试 API Checkout；若仍失败请检查后台账单地区',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('未找到') && normalized.includes('升级按钮')) {
        return {
            status: 'failed',
            message: runtimeError || '定价页未找到对应套餐升级按钮，请确认账号可升级',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('等待 Checkout 页面超时')) {
        return {
            status: 'failed',
            message: runtimeError || '点击升级后未跳转到 Checkout 页面',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('无法获取支付链接')
        || normalized.includes('API 创建 Checkout 失败')
        || normalized.includes('createCheckoutSession 失败')
        || normalized.includes('无法打开 Checkout 页面')
        || normalized.includes('订单创建失败')) {
        return {
            status: 'failed',
            message: runtimeError || '无法创建官方 Checkout 订单，请检查账号是否已订阅、账单地区与币种是否匹配',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('该账号无激活权限')
        || normalized.includes('not_eligible')
        || normalized.includes('Offer not found')) {
        return {
            status: 'failed',
            message: '该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('Browser does not support socks5 proxy authentication')
        || normalized.includes('socks5 proxy authentication')) {
        return {
            status: 'failed',
            message: '代理配置错误：Playwright 不支持带账号密码的 SOCKS5，系统已自动中继；若仍失败请检查代理 URL 或改用 HTTP 代理',
            reachedPayment: false,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理认证失败') || normalized.includes('代理响应异常') || normalized.includes('账号余额')) {
        return {
            status: 'failed',
            message: '系统维护中,请联系管理员修复',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理连接失败') || normalized.includes('代理响应异常')) {
        return {
            status: 'maintenance',
            message: '系统维护中,请联系管理员修复',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('监测到致命拦截文字')
        || normalized.includes('监测到致命拦截')
        || normalized.includes('You have been blocked')) {
        return {
            status: 'retry',
            message: '监测到致命拦截文字，准备重试',
            reachedPayment: true,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('手机号被拒绝或系统拦截')) {
        return {
            status: 'retry',
            message: '手机号不可用，准备重试',
            reachedPayment,
            shouldRetry: true,
            deletePhone: true,
            deleteCard: false
        };
    }

    if (normalized.includes('短信验证码超时')
        || normalized.includes('该手机号无验证码')
        || normalized.includes('手机号短信验证异常')) {
        return {
            status: 'retry',
            message: '短信异常：手机号不可用，已禁用该号，准备重试',
            reachedPayment,
            shouldRetry: true,
            deletePhone: true,
            deleteCard: false
        };
    }

    if (normalized.includes('银行卡被拒绝')
        || normalized.includes('stripe_card_declined')
        || normalized.includes('支付失败 (stripe_redirect_failed)')
        || normalized.includes('支付失败 (stripe_redirect_canceled)')
        || normalized.includes('支付失败 (stripe_card_declined)')) {
        return {
            status: 'manual',
            message: '银行卡被拒绝或 Stripe 驳回，请查看截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: true
        };
    }

    if (normalized.includes('支付结果检测失败')
        || normalized.includes('支付结果等待超时')) {
        return {
            status: 'manual',
            message: '支付结果未确认，请查看截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('需要人工验证：触发 Cloudflare')
        || normalized.includes('captcha_challenge_required')) {
        return {
            status: 'manual',
            message: '触发 Cloudflare 人机验证（需勾选验证框），自动化无法可靠通过。请换住宅代理 IP，或 HEADFUL=1 有头模式人工勾选',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('支付失败 (manual_intervention)')
        || normalized.includes('manual_intervention')
        || normalized.includes('需要人工操作')
        || normalized.includes('人机验证')
        || normalized.includes('Cloudflare/人机验证')
        || normalized.includes('captcha_challenge')) {
        return {
            status: 'manual',
            message: runtimeError || '需要人工操作：支付自动化失败，请查看失败截图',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('支付失败 (payment_failed)')
        || normalized.includes('支付失败 (card_pool_exhausted)')) {
        return {
            status: 'manual',
            message: runtimeError || '支付失败，请查看运行日志与截图',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    // 已进入 Stripe/Checkout 支付流程后，任何失败都不再整单重试
    if (reachedPayment && (
        normalized.includes('支付失败')
        || normalized.includes('❌ [支付失败]')
        || normalized.includes('FAILURE_SCREENSHOT')
        || normalized.includes('billing_address_not_filled')
        || normalized.includes('账单地址未完整')
    )) {
        return {
            status: 'manual',
            message: runtimeError || '支付流程失败，请查看失败截图后人工处理',
            reachedPayment: true,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('代理或网络持续超时')
        || normalized.includes('浏览器连接被代理多次关闭')) {
        return {
            status: 'retry',
            message: '当前代理超时严重，已切换代理重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('OpenAI 鉴权服务异常')
        || normalized.includes('/auth/error?error=undefined')
        || normalized.includes('chatgpt.com/auth/error')) {
        return {
            status: 'retry',
            message: 'OpenAI 鉴权风控 (auth/error)，换代理 IP 重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('user_already_exists')
        || normalized.includes('该邮箱已被注册')) {
        return {
            status: 'retry',
            message: '邮箱已被注册，自动换下一个邮箱重试',
            reachedPayment: false,
            shouldRetry: true,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('该账号无激活权限,请更换账号重试')) {
        return {
            status: 'failed',
            message: '该账号不符合订阅条件（可能已订阅或地区不支持），请更换账号或调整后台账单地区',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (normalized.includes('❌ [运行时错误]') || runtimeError) {
        return {
            status: 'failed',
            message: runtimeError || '自动化执行失败，请查看运行日志',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (!reachedPayment) {
        const deepCheckoutFlow =
            normalized.includes('Stripe')
            || normalized.includes('pay.openai.com')
            || normalized.includes('Checkout')
            || normalized.includes('正在打开 Stripe');
        if (deepCheckoutFlow) {
            return {
                status: 'retry',
                message: '已进入支付流程但未完成，准备重试',
                reachedPayment: false,
                shouldRetry: true,
                deletePhone: false,
                deleteCard: false
            };
        }
        return {
            status: 'failed',
            message: runtimeError || '开通失败，请查看运行日志排查 Session、账单地区或卡池配置',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    if (timedOut || normalized.includes("运行时错误")) {
        return {
            status: reachedPayment ? 'manual' : 'failed',
            message: reachedPayment
                ? '支付流程超时或中断，请查看失败截图后人工处理'
                : '激活失败',
            reachedPayment,
            shouldRetry: false,
            deletePhone: false,
            deleteCard: false
        };
    }

    return {
        status: reachedPayment ? 'manual' : 'failed',
        message: reachedPayment
            ? (runtimeError || '支付流程未完成，请查看失败截图后人工处理')
            : (runtimeError || '开通失败，请查看运行日志'),
        reachedPayment,
        shouldRetry: false,
        deletePhone: false,
        deleteCard: false
    };
}

function getCheckoutProgress(output, status = 'running') {
    const text = String(output || '');
    const markers = [
        ['正在检查代理连通性', 2],
        ['代理连接成功! 代理公网 IP', 5],
        ['[1] 准备自助充值', 8],
        ['Session 登录成功', 12],
        ['正在通过 API 创建 Checkout', 20],
        ['Checkout 页面已打开', 35],
        ['CHECKOUT_DEBUG_SUCCESS', 100],
        ['CHECKOUT_URL:', 95],
        ['已打开 ChatGPT 定价页', 15],
        ['[Stripe] Step 1', 45],
        ['[Stripe] Step 6', 60],
        ['[Stripe] Step 9', 80],
        ['[Stripe] Step 10', 90],
        ['正在使用 Stripe 信用卡卡池支付流程', 40],
        ['最终校验：支付成功!', 100],
        ['PAYMENT_SUCCESS', 100]
    ];

    let progress = 0;
    for (const [marker, value] of markers) {
        if (text.includes(marker)) {
            progress = Math.max(progress, value);
        }
    }

    if (status === 'success') return 100;
    return Math.min(progress, 99);
}

function normalizeTaskProgress(progress, status = 'running', previous = 0) {
    const numericProgress = Number(progress);
    const safeProgress = Number.isFinite(numericProgress) ? Math.max(0, Math.round(numericProgress)) : 0;
    const cappedProgress = status === 'success' ? Math.min(safeProgress, 100) : Math.min(safeProgress, 99);
    return Math.max(Math.max(0, Number(previous) || 0), cappedProgress);
}

function runCheckoutScript(jobKey, scriptPath, env, attempt = 1, onProgress = null) {
    return new Promise((resolve) => {
        logTask(jobKey, `启动子进程 attempt=${attempt} script=${scriptPath}`);
        const child = spawn('node', [scriptPath], {
            env,
            windowsHide: true
        });

        let output = '';
        let idleTimer = null;
        let finished = false;
        let timedOut = false;

        activeProcesses.add(child);
        const cleanup = () => {
            activeProcesses.delete(child);
            if (idleTimer) clearTimeout(idleTimer);
        };

        const finish = (result) => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve({ attempt, ...result });
        };

        const resetIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => {
                timedOut = true;
                output += '\n[TIMEOUT] 超过 3 分钟没有打印，任务终止。\n';
                logTask(jobKey, `attempt=${attempt} 超过 ${PROCESS_IDLE_TIMEOUT_MS / 1000} 秒无输出，终止子进程`, 'warn');
                child.kill();
            }, PROCESS_IDLE_TIMEOUT_MS);
        };

        const appendChunk = (source, chunk) => {
            const text = chunk.toString();
            output += text;
            logTaskChunk(jobKey, attempt, source, text);
            if (onProgress) {
                onProgress(getCheckoutProgress(output), output).catch((error) => console.error('[Progress Update Error]', error));
            }
            resetIdleTimer();
        };

        resetIdleTimer();
        child.stdout.on('data', (chunk) => appendChunk('stdout', chunk));
        child.stderr.on('data', (chunk) => appendChunk('stderr', chunk));
        child.on('error', (error) => {
            output += `\n[SPAWN_ERROR] ${error.message}\n`;
            logTask(jobKey, `attempt=${attempt} 子进程启动失败: ${error.message}`, 'error');
        });
        child.on('close', (code, signal) => {
            cleanup();
            logTask(jobKey, `attempt=${attempt} 子进程退出 code=${code} signal=${signal || 'none'} timedOut=${timedOut}`);
            finish({
                code,
                signal,
                timedOut,
                output,
                analysis: analyzeProcessOutput(output, timedOut)
            });
        });
    });
}

app.get('/admin', (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});

app.get(['/admin-login', '/admin-login/', '/admin-login.html'], (req, res) => {
    res.status(404).type('text/plain').send('Not Found');
});

app.post('/api/admin/login', async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '请输入管理员邮箱和密码' });
    }

    const rate = adminAuth.checkLoginRateLimit(clientMeta.ip);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `登录尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const emailOk = email === adminAuth.normalizeEmail(authConfig.email);
        const passwordOk = verifyPassword(password, authConfig.passwordHash);

        if (!emailOk || !passwordOk) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('login_failed', {
                ...clientMeta,
                email,
                detail: '邮箱或密码错误'
            });
            fireAdminSecurityNotification('admin_login_failed', {
                email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                message: '邮箱或密码错误'
            });
            return res.status(401).json({ success: false, message: '邮箱或密码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);

        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!adminAuth.is2faRequired(authConfig, telegramSettings)) {
            const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
            await logAdminSecurityEvent('login_success', {
                ...clientMeta,
                email: authConfig.email,
                detail: '密码登录（未启用二次验证）'
            });
            fireAdminSecurityNotification('admin_login_success', {
                email: authConfig.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method: 'password_only',
                message: '后台登录成功（尚未启用 2FA）'
            });
            return res.json(await attachAdminPaths({
                success: true,
                token,
                expiresAt: payload.exp,
                issuedAt: payload.iat,
                permissions: payload.permissions,
                email: authConfig.email,
                requires2fa: false,
                setupRequired: true
            }));
        }

        const challenge = adminAuth.issueLoginChallenge({
            email: authConfig.email,
            passwordVersion: authConfig.passwordVersion,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint
        });

        return res.json({
            success: true,
            requires2fa: true,
            challengeToken: challenge.token,
            methods,
            defaultMethod: adminAuth.pickDefaultLogin2faMethod(methods, authConfig.login2faMode === 'either' ? '' : authConfig.login2faMode),
            login2faMode: authConfig.login2faMode,
            email: authConfig.email,
            expiresAt: challenge.payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/login/send-tg-code', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);
    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    try {
        await ensureStoreReady();
        const code = adminAuth.generateTelegramLoginCode();
        adminAuth.storeTelegramLoginCode(challenge.cid, code);
        const clientMeta = adminAuth.getClientMeta(req);
        const sendResult = await sendTelegramLoginCode(store, code, {
            email: challenge.email,
            ip: clientMeta.ip || challenge.ip
        });
        if (!sendResult.ok) {
            return res.status(400).json({ success: false, message: sendResult.error || 'Telegram 验证码发送失败' });
        }
        return res.json({ success: true, message: '验证码已发送到管理员 Telegram' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/login/verify-2fa', async (req, res) => {
    const challengeToken = String(req.body?.challengeToken || '').trim();
    const method = String(req.body?.method || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const clientMeta = adminAuth.getClientMeta(req);
    const challenge = adminAuth.verifyLoginChallenge(challengeToken);

    if (!challenge) {
        return res.status(401).json({ success: false, message: '登录会话已过期，请重新登录' });
    }

    if (!code) {
        return res.status(400).json({ success: false, message: '请输入验证码' });
    }

    const rate = adminAuth.checkLoginRateLimit(`${clientMeta.ip}:2fa`);
    if (!rate.allowed) {
        return res.status(429).json({
            success: false,
            message: `验证尝试过多，请 ${rate.retryAfterSec} 秒后再试`
        });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const methods = adminAuth.resolveLogin2faMethods(authConfig, telegramSettings);
        if (!methods.includes(method)) {
            return res.status(400).json({ success: false, message: '不支持的验证方式' });
        }

        let verified = false;
        if (method === 'totp') {
            verified = adminAuth.verifyTotpCode(authConfig.totpSecret, code);
        } else if (method === 'telegram') {
            const tgResult = adminAuth.verifyTelegramLoginCode(challenge.cid, code);
            verified = tgResult.ok;
            if (!verified) {
                adminAuth.recordLoginFailure(rate.key, rate.entry);
                await logAdminSecurityEvent('2fa_failed', {
                    ...clientMeta,
                    email: challenge.email,
                    detail: `Telegram 验证码错误 (${tgResult.reason || 'invalid'})`
                });
                fireAdminSecurityNotification('admin_2fa_failed', {
                    email: challenge.email,
                    ip: clientMeta.ip,
                    fingerprint: clientMeta.fingerprint,
                    userAgent: clientMeta.userAgent,
                    method: 'telegram',
                    message: 'Telegram 验证码错误'
                });
                const message = tgResult.reason === 'expired'
                    ? '验证码已过期，请重新获取'
                    : 'Telegram 验证码错误';
                return res.status(401).json({ success: false, message });
            }
        }

        if (!verified) {
            adminAuth.recordLoginFailure(rate.key, rate.entry);
            await logAdminSecurityEvent('2fa_failed', {
                ...clientMeta,
                email: challenge.email,
                detail: `${method} 验证码错误`
            });
            fireAdminSecurityNotification('admin_2fa_failed', {
                email: challenge.email,
                ip: clientMeta.ip,
                fingerprint: clientMeta.fingerprint,
                userAgent: clientMeta.userAgent,
                method,
                message: '二次验证失败'
            });
            return res.status(401).json({ success: false, message: '验证码错误' });
        }

        adminAuth.clearLoginAttempts(rate.key);
        const { token, payload } = issueAdminToken(authConfig.passwordVersion, authConfig.email);
        await logAdminSecurityEvent('login_success', {
            ...clientMeta,
            email: authConfig.email,
            detail: `二次验证成功 (${method})`
        });
        fireAdminSecurityNotification('admin_login_success', {
            email: authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            method,
            message: '后台登录成功'
        });

        return res.json(await attachAdminPaths({
            success: true,
            token,
            expiresAt: payload.exp,
            issuedAt: payload.iat,
            permissions: payload.permissions,
            email: authConfig.email
        }));
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

/** 运行日志：必须挂在 app.use('/api/admin', authenticateAdmin) 之前，并为每条路由单独鉴权，否则部分环境下会 404 */
app.get('/api/admin/runtime-logs', authenticateAdmin, (req, res) => {
    try {
        const wantTail = String(req.query.tail || '') === '1' || String(req.query.tail || '') === 'true';
        const after = Math.max(0, parseInt(String(req.query.after || '0'), 10) || 0);
        let limit = parseInt(String(req.query.limit || '500'), 10) || 500;
        limit = Math.min(2000, Math.max(1, limit));

        const entries = wantTail ? runtimeLog.tail(limit) : runtimeLog.after(after, limit);
        const nextAfter = entries.length ? entries[entries.length - 1].id : after;
        res.json({ success: true, entries, nextAfter });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/runtime-logs/clear', authenticateAdmin, (req, res) => {
    try {
        runtimeLog.clear();
        runtimeLog.push({ jobKey: '', level: 'system', source: 'server', text: '🧹 运行日志已手动清空' });
        res.json({ success: true, message: '运行日志已清空' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


/** 代理批量测试：支持临时 URL 或已保存代理 ID；检测后可选写回 proxy_assets。 */
app.post('/api/admin/proxy/test', authenticateAdmin, async (req, res) => {
    try {
        await ensureStoreReady();
        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id) => Number(id)).filter((id) => id > 0)
            : [];
        const rawProxies = normalizeProxyLines(req.body?.proxies || []);
        const persist = req.body?.persist !== false;

        let targets = [];
        if (ids.length) {
            const saved = await store.listProxyAssets();
            const map = new Map(saved.map((item) => [item.id, item]));
            targets = ids.map((id) => {
                const row = map.get(id);
                return row ? { id, proxy_url: row.proxy_url } : null;
            }).filter(Boolean);
        } else {
            targets = rawProxies.map((proxy_url) => ({ id: null, proxy_url }));
        }

        if (!targets.length) {
            return res.status(400).json({ success: false, message: '未提供代理 URL 或 ID' });
        }
        if (targets.length > 50) {
            return res.status(400).json({ success: false, message: '一次最多测试 50 条代理' });
        }

        const results = await Promise.all(targets.map(async (target) => {
            const result = await testProxyUrl(target.proxy_url);
            if (persist && target.id) {
                await store.updateProxyAssetCheck(target.id, result);
            }
            return {
                id: target.id,
                proxy_url: target.proxy_url,
                ...result
            };
        }));

        return res.json({ success: true, results });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});


// ─── External Card Pool Webhook (X-API-Key auth) ────────────────────────────
app.post('/api/external/cards/push', async (req, res) => {
    try {
        await ensureStoreReady();
        const apiKey = String(req.headers['x-api-key'] || '').trim();
        if (!apiKey) {
            return res.status(401).json({ success: false, error: 'API Key 无效或缺失' });
        }
        const expectedKey = await store.getAppConfigValue('external_card_api_key', '');
        if (!expectedKey || apiKey !== expectedKey) {
            return res.status(401).json({ success: false, error: 'API Key 无效或缺失' });
        }

        const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
        if (cards.length === 0) {
            return res.status(400).json({ success: false, error: '缺少 cards 数组或为空' });
        }
        if (cards.length > 500) {
            return res.status(400).json({ success: false, error: '单次导入上限 500 条' });
        }

        const result = await store.importCards(cards);
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.message === '单次导入上限 500 条') {
            return res.status(400).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

/** 公开 API：必须挂在 app.use('/api/admin', authenticateAdmin) 之前，否则部分环境下会 404 */
app.get('/api/public/admin-paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const paths = await store.getAdminPaths();
        return res.json({
            success: true,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/public/subscription/check', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await querySubscriptionBySession(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            return res.status(result.statusCode || 502).json({
                success: false,
                message: result.error || '查询订阅失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.use('/api/admin', authenticateAdmin);

app.get('/subscription', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'subscription.html'));
});

app.get('/api/public/payment-region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
        return res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/public/runtime', async (req, res) => {
    try {
        await ensureStoreReady();
        const maxConcurrentActivations = await store.getMaxConcurrentActivations();
        return res.json({
            success: true,
            runtime: {
                active_foreground_jobs: activeForegroundJobs.size,
                max_foreground_jobs: Math.max(1, Number(maxConcurrentActivations || 1))
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/session', (req, res) => {
    const age = Date.now() - Number(req.admin.iat || 0);
    const shouldRefresh = age >= ADMIN_REFRESH_AFTER_MS;
    let refreshedToken = null;
    let payload = req.admin;

    if (shouldRefresh) {
        const refreshed = issueAdminToken(req.admin.pv, req.admin.email);
        refreshedToken = refreshed.token;
        payload = refreshed.payload;
    }

    return res.json({
        success: true,
        refreshed: shouldRefresh,
        token: refreshedToken,
        expiresAt: payload.exp,
        issuedAt: payload.iat,
        permissions: payload.permissions,
        email: payload.email || ''
    });
});

app.get('/api/admin/security/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        const telegramSettings = await store.getTelegramConfig();
        const paths = await store.getAdminPaths();
        res.json({
            success: true,
            email: authConfig.email,
            totpEnabled: authConfig.totpEnabled,
            login2faMode: authConfig.login2faMode,
            availableMethods: adminAuth.getAvailable2faMethods(authConfig, telegramSettings),
            methods: adminAuth.resolveLogin2faMethods(authConfig, telegramSettings),
            notifyAdminLogin: authConfig.notifyAdminLogin,
            loginPath: paths.loginPath,
            panelPath: paths.panelPath,
            loginUrl: buildAdminLoginUrl(paths),
            panelUrl: buildAdminPanelUrl(paths)
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/login-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Number(req.query.limit) || 100;
        const offset = Number(req.query.offset) || 0;
        res.json({ success: true, ...(await store.listAdminLoginLogs(limit, offset)) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/secondary/session', (req, res) => {
    const token = String(req.headers['x-admin-secondary-token'] || '').trim();
    const payload = adminAuth.verifySecondaryToken(token);
    if (!payload) {
        return res.json({ success: true, verified: false });
    }
    return res.json({
        success: true,
        verified: true,
        expiresAt: payload.exp
    });
});

app.post('/api/admin/verify-secondary', async (req, res) => {
    const password = String(req.body?.password || '');
    const clientMeta = adminAuth.getClientMeta(req);
    if (!password) {
        return res.status(400).json({ success: false, message: '请输入二级密码' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(password, authConfig.secondaryPasswordHash)) {
            await logAdminSecurityEvent('secondary_failed', {
                ...clientMeta,
                email: req.admin?.email || authConfig.email,
                detail: '二级密码错误'
            });
            return res.status(401).json({ success: false, message: '二级密码错误' });
        }

        const { token, payload } = adminAuth.issueSecondaryToken(
            authConfig.secondaryPasswordVersion,
            clientMeta.ip
        );
        await logAdminSecurityEvent('secondary_success', {
            ...clientMeta,
            email: req.admin?.email || authConfig.email,
            detail: '敏感模块解锁'
        });
        fireAdminSecurityNotification('admin_secondary_success', {
            email: req.admin?.email || authConfig.email,
            ip: clientMeta.ip,
            fingerprint: clientMeta.fingerprint,
            userAgent: clientMeta.userAgent,
            message: '银行卡池/CDK/Session 模块已解锁'
        });
        return res.json({
            success: true,
            secondaryToken: token,
            expiresAt: payload.exp
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/security/2fa-mode', async (req, res) => {
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    try {
        await ensureStoreReady();
        const saved = await store.saveAdmin2faLoginMode(mode);
        res.json({ success: true, login2faMode: saved, message: '登录验证方式已保存' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/security/paths', async (req, res) => {
    try {
        await ensureStoreReady();
        const saved = await store.saveAdminPaths({
            loginPath: req.body?.loginPath,
            panelPath: req.body?.panelPath
        });
        invalidateAdminPathsCache();
        cachedAdminPaths = saved;
        return res.json({
            success: true,
            loginPath: saved.loginPath,
            panelPath: saved.panelPath,
            loginUrl: buildAdminLoginUrl(saved),
            panelUrl: buildAdminPanelUrl(saved),
            message: '入口路径已更新，请使用新地址访问并收藏'
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/setup', async (req, res) => {
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        let secret = String(authConfig.totpSecret || '').trim();
        if (!secret || authConfig.totpEnabled) {
            secret = adminAuth.generateTotpSecret();
            await store.saveAdminTotpConfig({ secret, enabled: false });
        }
        const otpauthUrl = adminAuth.getTotpUri(authConfig.email, secret);
        res.json({
            success: true,
            secret,
            otpauthUrl,
            qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(otpauthUrl)}`,
            message: '请使用 Google Authenticator 扫码后输入验证码确认启用'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/confirm', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) {
        return res.status(400).json({ success: false, message: '请输入 Authenticator 验证码' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!authConfig.totpSecret) {
            return res.status(400).json({ success: false, message: '请先发起 2FA 绑定' });
        }
        if (!adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: '验证码错误，请重试' });
        }
        await store.saveAdminTotpConfig({ secret: authConfig.totpSecret, enabled: true });
        res.json({ success: true, message: 'Google Authenticator 已启用' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/2fa/disable', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const code = String(req.body?.code || '').trim();
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '登录密码错误' });
        }
        if (authConfig.totpEnabled && !adminAuth.verifyTotpCode(authConfig.totpSecret, code)) {
            return res.status(400).json({ success: false, message: 'Authenticator 验证码错误' });
        }
        await store.saveAdminTotpConfig({ secret: '', enabled: false });
        res.json({ success: true, message: 'Google Authenticator 已关闭' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/change-secondary-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();
    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入当前二级密码' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新二级密码至少 6 位' });
    }
    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.secondaryPasswordHash)) {
            return res.status(400).json({ success: false, message: '当前二级密码错误' });
        }
        await store.updateAdminSecondaryPassword(newPassword);
        res.json({ success: true, message: '二级密码已更新，敏感模块需重新验证' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/task-logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        const tasks = await store.listAdminTaskLogs(limit);
        res.json({ success: true, tasks });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        await ensureStoreReady();
        const data = await store.getAdminData();
        const system = await getSystemMetrics();
        data.runtime = {
            active_activation_jobs: getTotalActiveJobs(),
            active_foreground_jobs: activeForegroundJobs.size,
            system,
            browser_pool: browserPool.getStats()
        };
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/browser-pool', async (req, res) => {
    try {
        await ensureStoreReady();
        const modeEnabled = await store.getBrowserPoolEnabled();
        const system = await getSystemMetrics();
        const memText = String(system?.memory?.text || '');
        const memMatch = memText.match(/([\d.]+)G\/([\d.]+)G/);
        const hostMemory = memMatch
            ? { usedGb: Number(memMatch[1]), totalGb: Number(memMatch[2]) }
            : null;
        const pool = await browserPool.getDetailedStats(hostMemory);
        res.json({
            success: true,
            pool,
            mode: {
                enabled: modeEnabled,
                runtime: browserPool.getRuntimeEnabled(),
                workerMode: modeEnabled ? 'pool' : 'standalone'
            },
            system,
            foreground: {
                activeJobs: getTotalActiveJobs(),
                activeForegroundJobs: activeForegroundJobs.size
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/browser-pool/mode', async (req, res) => {
    try {
        await ensureStoreReady();
        const enabled = req.body?.enabled === true
            || req.body?.enabled === 1
            || String(req.body?.enabled || '').trim() === '1';
        await store.setBrowserPoolEnabled(enabled);
        const info = await syncBrowserPoolModeFromStore();
        res.json({
            success: true,
            message: enabled
                ? `已切换为浏览器池模式（${info.size || 0} 个槽位）`
                : '已切换为独立浏览器模式（每任务冷启动 Chromium）',
            mode: {
                enabled,
                runtime: browserPool.getRuntimeEnabled(),
                workerMode: enabled ? 'pool' : 'standalone'
            },
            pool: browserPool.getStats()
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/browser-pool/reload', async (req, res) => {
    try {
        await ensureStoreReady();
        const requestedSize = req.body?.size;
        if (requestedSize != null) {
            browserPool.setRuntimePoolSize(requestedSize);
        }
        const result = await browserPool.reloadBrowserPool(requestedSize);
        res.json({
            success: true,
            message: `浏览器池已重载，当前 ${result.size} 个槽位`,
            pool: browserPool.getStats()
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/sessions', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
        res.json(await store.listSessions({ limit }));
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/sessions/:jobKey', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const session = await store.getSessionByJobKey(req.params.jobKey);
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session 记录不存在' });
        }
        res.json({ success: true, session });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/cancel-auto-renew', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await cancelAutoRenew(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            const responseStatusCode = result.statusCode === 401 ? 422 : (result.statusCode || 502);
            return res.status(responseStatusCode).json({
                success: false,
                message: result.error || '取消自动续费失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/enable-auto-renew', async (req, res) => {
    try {
        const rawSession = String(req.body?.session || req.body?.token || '').trim().replace(/^\uFEFF/, '');
        if (!rawSession) {
            return res.status(400).json({ success: false, message: '请粘贴 Session JSON 或 AccessToken' });
        }

        const token = normalizeSessionToken(rawSession);
        const tokenCheck = validateSessionTokenForQuery(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, message: tokenCheck.message });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const result = await resumeAutoRenew(token, {
            timezoneOffsetMin: Number.isFinite(timezoneOffsetMin)
                ? timezoneOffsetMin
                : -new Date().getTimezoneOffset(),
            email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
        });

        if (!result.ok) {
            const responseStatusCode = result.statusCode === 401 ? 422 : (result.statusCode || 502);
            return res.status(responseStatusCode).json({
                success: false,
                message: result.error || '开启自动续费失败'
            });
        }

        return res.json({ success: true, data: result.data });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/subscription/batch-renewal-status', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKeys = Array.isArray(req.body?.job_keys)
            ? req.body.job_keys.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50)
            : [];
        if (!jobKeys.length) {
            return res.json({ success: true, data: {} });
        }

        const timezoneOffsetMin = Number(req.body?.timezone_offset_min);
        const offset = Number.isFinite(timezoneOffsetMin)
            ? timezoneOffsetMin
            : -new Date().getTimezoneOffset();
        const concurrency = 3;
        const results = {};
        let cursor = 0;

        async function queryJobRenewalStatus(jobKey) {
            const session = await store.getSessionByJobKey(jobKey);
            if (!session?.session_payload) {
                results[jobKey] = { ok: false, error: '无完整 Session' };
                return;
            }

            const rawSession = String(session.session_payload || '').trim();
            const token = normalizeSessionToken(rawSession);
            const tokenCheck = validateSessionTokenForQuery(token);
            if (!tokenCheck.valid) {
                results[jobKey] = { ok: false, error: tokenCheck.message };
                return;
            }

            const queryResult = await querySubscriptionBySession(token, {
                timezoneOffsetMin: offset,
                email: extractEmailFromSession(rawSession) || tokenCheck.email || ''
            });
            if (!queryResult.ok) {
                results[jobKey] = { ok: false, error: queryResult.error || '查询失败' };
                return;
            }

            const data = queryResult.data || {};
            results[jobKey] = {
                ok: true,
                email: data.email || '',
                autoRenew: data.autoRenew || '—',
                autoRenewRaw: data.autoRenewRaw,
                hasActiveSubscription: Boolean(data.hasActiveSubscription),
                subscriptionChannel: data.subscriptionChannel || ''
            };
        }

        async function worker() {
            while (cursor < jobKeys.length) {
                const index = cursor;
                cursor += 1;
                await queryJobRenewalStatus(jobKeys[index]);
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, jobKeys.length) }, () => worker()));
        return res.json({ success: true, data: results });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/screenshots', async (req, res) => {
    try {
        const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || !rel.endsWith('.png')) {
            return res.status(400).json({ success: false, message: '无效的截图路径' });
        }
        const root = path.join(__dirname, 'debug_screenshots');
        let fullPath = path.join(root, rel);
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            if (rel.startsWith('激活/')) {
                const altPath = path.join(root, 'activation', rel.slice('激活/'.length));
                if (altPath.startsWith(root) && fs.existsSync(altPath)) {
                    fullPath = altPath;
                }
            }
        }
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '截图不存在' });
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/video', async (req, res) => {
    try {
        const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || !rel.endsWith('.webm')) {
            return res.status(400).json({ success: false, message: '无效的录像路径' });
        }
        const root = path.join(__dirname, 'debug_screenshots');
        const fullPath = path.join(root, rel);
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '录像不存在' });
        }
        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/screenshots/:subdir/:filename', async (req, res) => {
    try {
        const subdir = path.basename(String(req.params.subdir || ''));
        const filename = path.basename(String(req.params.filename || ''));
        if (!subdir || !filename || !filename.endsWith('.png')) {
            return res.status(400).json({ success: false, message: '无效的截图路径' });
        }
        const fullPath = path.join(__dirname, 'debug_screenshots', subdir, filename);
        const root = path.join(__dirname, 'debug_screenshots');
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
            return res.status(404).json({ success: false, message: '截图不存在' });
        }
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.sendFile(fullPath);
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/task-logs/:jobKey', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
        if (!jobKey) {
            return res.status(400).json({ success: false, message: '缺少任务标识' });
        }
        const { deleted, mediaDeleted } = await store.deleteTaskLogByJobKey(jobKey);
        if (!deleted) {
            return res.status(404).json({ success: false, message: '未找到该任务记录' });
        }
        return res.json({
            success: true,
            message: mediaDeleted > 0
                ? `任务记录已删除，并清理 ${mediaDeleted} 个截图/录像文件`
                : '任务记录已删除'
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

function fireTelegramNotification(event, payload) {
    notifyTelegramEvent(store, event, payload).catch((error) => {
        console.error(`[Telegram] ${event} 通知失败:`, error.message);
    });
}

function notifyTaskOutcome({ event, email, cdk, jobKey, message }) {
    fireTelegramNotification(event, { email, cdk, jobKey, message });
}

app.post('/api/admin/telegram', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveTelegramConfig({
            bot_token: body.bot_token,
            admin_chat_id: body.admin_chat_id,
            group_chat_id: body.group_chat_id,
            notify_admin: Boolean(body.notify_admin),
            notify_group: Boolean(body.notify_group),
            on_success: Boolean(body.on_success),
            on_failure: Boolean(body.on_failure),
            on_card_pool_empty: Boolean(body.on_card_pool_empty)
        });
        res.json({ success: true, message: 'Telegram 通知配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/card-supplier', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body ?? {};
        await store.saveCardSupplierWebhookConfig({ webhook_secret: body.webhook_secret });
        res.json({ success: true, message: '卡片供应商 Webhook Secret 已保存并立即生效' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/telegram/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await sendTelegramTest(store, req.body || {});
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: result.message });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveHcaptchaConfig({
            enabled: Boolean(body.enabled),
            vlm_api_key: body.vlm_api_key,
            vlm_base_url: body.vlm_base_url,
            vlm_model: body.vlm_model,
            vlm_timeout: body.vlm_timeout,
            solver_timeout: body.solver_timeout,
            no_vlm: Boolean(body.no_vlm),
            cdp_port: body.cdp_port,
            captcha_platform_api_key: body.captcha_platform_api_key,
            captcha_platform_api_url: body.captcha_platform_api_url,
            captcha_platform_timeout: body.captcha_platform_timeout
        });
        res.json({ success: true, message: 'hCaptcha 求解器配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getHcaptchaConfig();
        const { env } = buildHcaptchaEnvFromConfig(cfg);
        const prevEnv = {};
        for (const [key, value] of Object.entries(env)) {
            prevEnv[key] = process.env[key];
            process.env[key] = value;
        }
        try {
            const status = await checkHcaptchaSolverHealth(cfg);
            if (!status.ready) {
                return res.status(400).json({ success: false, message: status.message, status });
            }
            res.json({ success: true, message: status.message, status });
        } finally {
            for (const [key, value] of Object.entries(prevEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test-vlm', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const cfg = await store.getHcaptchaConfig();
        const merged = {
            ...cfg,
            vlm_api_key: String(body.vlm_api_key || '').trim() || cfg.vlm_api_key,
            vlm_base_url: String(body.vlm_base_url || '').trim() || cfg.vlm_base_url,
            vlm_model: String(body.vlm_model || '').trim() || cfg.vlm_model,
            vlm_timeout: body.vlm_timeout ?? cfg.vlm_timeout
        };
        const result = await testVlmConnectivity(merged);
        if (!result.ok) {
            return res.status(400).json({ success: false, ...result });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/hcaptcha/test-captcha-platform', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const cfg = await store.getHcaptchaConfig();
        const merged = {
            captcha_platform_api_key: String(body.captcha_platform_api_key || '').trim() || cfg.captcha_platform_api_key,
            captcha_platform_api_url: String(body.captcha_platform_api_url || '').trim() || cfg.captcha_platform_api_url,
            captcha_platform_timeout: body.captcha_platform_timeout ?? cfg.captcha_platform_timeout
        };
        const resolved = resolveCaptchaPlatformCredentials(
            merged.captcha_platform_api_key,
            merged.captcha_platform_api_url
        );
        merged.captcha_platform_api_url = resolved.apiUrl;
        if (resolved.apiKey) {
            await store.saveHcaptchaConfig({
                ...cfg,
                captcha_platform_api_key: resolved.apiKey,
                captcha_platform_api_url: resolved.apiUrl,
                captcha_platform_timeout: merged.captcha_platform_timeout
            });
        }
        const result = await testCaptchaPlatformConnectivity({
            apiKey: merged.captcha_platform_api_key,
            apiUrl: merged.captcha_platform_api_url,
            timeoutSec: merged.captcha_platform_timeout
        });
        if (!result.ok) {
            return res.status(400).json({ success: false, ...result });
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/hcaptcha/logs', async (req, res) => {
    try {
        await ensureStoreReady();
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 15));
        const listing = listSolverLogFiles(limit);
        const file = String(req.query.file || '').trim();
        if (file) {
            const safeName = path.basename(file);
            const target = listing.files.find((item) => item.name === safeName);
            if (!target) {
                return res.status(404).json({ success: false, message: '日志文件不存在' });
            }
            const lines = readSolverLogTail(target.path, 120);
            return res.json({ success: true, file: safeName, lines, ...listing });
        }
        const captchaRuntime = runtimeLog.tail(200).filter((e) => e.source === 'captcha' || e.level === 'captcha');
        res.json({ success: true, runtime: captchaRuntime.slice(-80), ...listing });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── 第三方 GPT 代充 API 配置 ──────────────────────────────────────────────

app.get('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        const masked = gptApi.maskApiKey(cfg.api_key);
        res.json({
            success: true,
            config: {
                enabled: cfg.enabled,
                base_url: cfg.base_url,
                api_key_saved: Boolean(cfg.api_key),
                api_key_preview: masked,
                plan_key: cfg.plan_key,
                country: cfg.country,
                currency: cfg.currency
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/gpt-api', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        await store.saveGptApiConfig({
            enabled: Boolean(body.enabled),
            base_url: body.base_url,
            api_key: body.api_key,
            plan_key: body.plan_key,
            country: body.country,
            currency: body.currency
        });
        res.json({ success: true, message: '第三方代充 API 配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/gpt-api/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const saved = await store.getGptApiConfig();
        const merged = {
            base_url: String(body.base_url || '').trim() || saved.base_url,
            api_key: String(body.api_key || '').trim() || saved.api_key
        };
        const result = await gptApi.testConnection(merged);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.error || '连接失败' });
        }
        res.json({ success: true, message: result.message, plans: result.plans, balance: result.balance });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/gpt-api/status', async (req, res) => {
    try {
        await ensureStoreReady();
        const cfg = await store.getGptApiConfig();
        if (!cfg.api_key) {
            return res.status(400).json({ success: false, message: '尚未配置第三方代充 API Key' });
        }
        const [plansResult, balanceResult, recentOrders] = await Promise.all([
            gptApi.fetchPlans(cfg),
            gptApi.queryBalance(cfg),
            store.listRecentGptApiOrders(10)
        ]);
        if (!plansResult.success) {
            return res.status(400).json({ success: false, message: `套餐查询失败: ${plansResult.error || '未知错误'}` });
        }
        const orders = recentOrders.map((order) => ({
            job_key: order.job_key,
            cdk_code: order.cdk_code,
            status: order.status,
            message: order.message,
            updated_at: order.updated_at,
            order_id: order.gpt_api_order_id,
            task_id: order.gpt_api_task_id,
            topup_code: order.gpt_api_topup_code || null
        }));
        res.json({
            success: true,
            gpt_plans: plansResult.gptPlans,
            credit_plans: plansResult.creditPlans,
            balance: balanceResult.success ? balanceResult.data : null,
            balance_error: balanceResult.success ? null : balanceResult.error,
            recent_orders: orders
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/config', async (req, res) => {
    try {
        await ensureStoreReady();
        const nextConfig = { ...(req.body || {}) };
        if (nextConfig.maintenance_mode) {
            nextConfig.maintenance_mode_drain = getTotalActiveJobs() > 0;
        } else {
            nextConfig.maintenance_mode_drain = false;
        }
        await store.saveConfig(nextConfig);
        res.json({ success: true, message: '所有资产配置已保存' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Region Selector API ────────────────────────────────────────────────────

app.get('/api/admin/region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode];
        res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label,
            supported: REGION_CONFIG
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/region', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = String(req.body?.region || '').toUpperCase();
        if (!isSupportedRegion(regionCode)) {
            return res.status(400).json({ success: false, error: '不支持的地区代码' });
        }
        const result = await store.setPaymentRegion(regionCode);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error });
        }
        const config = REGION_CONFIG[regionCode];
        res.json({
            success: true,
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Checkout Link Debug API ────────────────────────────────────────────────

app.get('/api/admin/checkout/plans', async (req, res) => {
    try {
        await ensureStoreReady();
        const regionCode = await store.getPaymentRegion();
        const config = REGION_CONFIG[regionCode] || REGION_CONFIG.PH;
        res.json({
            success: true,
            plans: store.PLAN_NAME_MAP,
            resolved: {
                plus: store.resolvePlanName('plus'),
                pro_5x: store.resolvePlanName('pro_5x'),
                pro_20x: store.resolvePlanName('pro_20x')
            },
            region: regionCode,
            currency: config.currency,
            label: config.label
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/checkout/generate', async (req, res) => {
    try {
        await ensureStoreReady();
        const body = req.body || {};
        const rawSession = String(body.session || '').trim();
        if (!rawSession) {
            return res.status(400).json({ success: false, error: '请提供 Session JSON' });
        }

        const sessionJson = parseSessionJson(rawSession);
        const token = normalizeSessionToken(rawSession);
        if (!token) {
            return res.status(400).json({ success: false, error: 'Session 无效，无法提取 accessToken' });
        }
        const tokenCheck = validateAccessToken(token);
        if (!tokenCheck.valid) {
            return res.status(400).json({ success: false, error: tokenCheck.message });
        }

        const planType = String(body.plan_type || 'plus').trim();
        const planNameOverride = body.plan_name ? String(body.plan_name).trim() : '';
        const resolvedPlanName = planNameOverride || store.resolvePlanName(planType);
        const regionCode = String(body.country || body.region || await store.getPaymentRegion()).toUpperCase();
        if (!isSupportedRegion(regionCode)) {
            return res.status(400).json({ success: false, error: `不支持的地区: ${regionCode}` });
        }

        const storedSession = buildStoredSessionPayload(rawSession, sessionJson, token);
        const email = extractEmailFromSession(sessionJson);
        const task = await store.createTaskLog({
            tokenPreview: extractSessionPreview(storedSession),
            sessionPayload: storedSession,
            cdkCode: '[checkout-debug]',
            phone: null,
            cardLast4: null,
            status: 'running',
            progress: 5
        });

        await store.updateTaskLog(task.jobKey, {
            status: 'running',
            message: `支付链接调试：${planType} / ${regionCode}`,
            progress: 5
        });

        logTask(task.jobKey, `支付链接调试任务已创建 plan=${planType} plan_name=${resolvedPlanName} region=${regionCode} email=${email || '-'}`);
        spawnCheckoutDebugWorker({
            task,
            token,
            sessionRaw: storedSession,
            planType,
            region: regionCode,
            planNameOverride: resolvedPlanName,
            email
        });

        return res.json({
            success: true,
            jobKey: task.jobKey,
            email: email || null,
            message: '浏览器调试任务已启动，请查看下方运行日志'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/checkout/status/:jobKey', async (req, res) => {
    try {
        await ensureStoreReady();
        const jobKey = decodeURIComponent(String(req.params.jobKey || '').trim());
        if (!jobKey) {
            return res.status(400).json({ success: false, error: '缺少 jobKey' });
        }
        const task = await store.getTaskStatus(jobKey);
        if (!task) {
            return res.status(404).json({ success: false, error: '任务不存在' });
        }
        const checkoutUrl = extractCheckoutUrlFromOutput(task.raw_output || '');
        let screenshots = [];
        if (task.failure_screenshots) {
            try {
                const parsed = JSON.parse(task.failure_screenshots);
                if (Array.isArray(parsed)) screenshots = parsed;
            } catch (_) { /* ignore */ }
        }
        if (!screenshots.length) {
            screenshots = extractScreenshotsFromOutput(task.raw_output || '');
        }
        const videos = extractVideosFromOutput(task.raw_output || '');
        res.json({
            success: true,
            jobKey,
            status: task.status,
            message: task.message,
            progress: Number(task.progress || 0),
            checkout_url: checkoutUrl || null,
            screenshots,
            videos
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Card Pool Management API ───────────────────────────────────────────────

app.get('/api/admin/cards', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const rows = await store.runQuery(
            `SELECT id, card_number, card_expiry, card_cvc, card_holder, decline_count,
                    payment_holder_name, payment_address_line1, payment_address_city,
                    payment_address_state, payment_address_postal, payment_address_id,
                    is_active, usage_count, last_used_at, status, cooldown_until
             FROM card_assets
             ORDER BY sort_order ASC, id ASC`
        );
        const cards = rows.map((row) => ({
            id: row.id,
            card_number: row.card_number || '',
            card_expiry: row.card_expiry || '',
            card_cvc: row.card_cvc || '',
            last4: String(row.card_number || '').slice(-4),
            card_holder: row.card_holder || '',
            payment_holder_name: row.payment_holder_name || '',
            payment_address_line1: row.payment_address_line1 || '',
            payment_address_city: row.payment_address_city || '',
            payment_address_state: row.payment_address_state || '',
            payment_address_postal: row.payment_address_postal || '',
            payment_address_id: row.payment_address_id || null,
            is_active: Number(row.is_active || 0),
            usage_count: Number(row.usage_count || 0),
            decline_count: Number(row.decline_count || 0),
            last_used_at: row.last_used_at || null,
            status: row.status || '正常',
            cooldown_until: row.cooldown_until || null
        }));
        res.json({ success: true, cards });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cards/import', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
        if (cards.length === 0) {
            return res.status(400).json({ success: false, error: '缺少 cards 数组或为空' });
        }
        if (cards.length > 500) {
            return res.status(400).json({ success: false, error: '单次导入上限 500 条' });
        }

        const result = await store.importCards(cards);
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.message === '单次导入上限 500 条') {
            return res.status(400).json({ success: false, error: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/cards/:id', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const cardId = Number(req.params.id);
        if (!cardId || !Number.isFinite(cardId)) {
            return res.status(400).json({ success: false, error: '无效的卡片 ID' });
        }
        const result = await store.runExecute(
            `DELETE FROM card_assets WHERE id = ?`,
            [cardId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: '卡片不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Proxy Pool CRUD API ────────────────────────────────────────────────────

app.get('/api/admin/proxies', async (req, res) => {
    try {
        await ensureStoreReady();
        const proxies = await store.listProxyAssets();
        res.json({ success: true, proxies });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/proxies', async (req, res) => {
    try {
        await ensureStoreReady();
        const input = req.body?.proxies ?? req.body?.proxy_url ?? req.body?.proxy ?? '';
        const result = await store.addProxyAssets(input);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/proxies/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active')) {
            const result = await store.setProxyAssetActive(id, Boolean(req.body.is_active));
            if (!result.success) {
                return res.status(404).json(result);
            }
            return res.json(result);
        }
        return res.status(400).json({ success: false, error: '缺少可更新字段' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/proxies/:id/test', async (req, res) => {
    try {
        await ensureStoreReady();
        const row = await store.getProxyAssetById(req.params.id);
        if (!row) {
            return res.status(404).json({ success: false, error: '代理不存在' });
        }
        const result = await testProxyUrl(row.proxy_url);
        await store.updateProxyAssetCheck(row.id, result);
        res.json({ success: true, id: row.id, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/proxies/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await store.deleteProxyAsset(req.params.id);
        if (!result.success) {
            return res.status(404).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Tax-Free Address CRUD API ──────────────────────────────────────────────

app.get('/api/admin/addresses', async (req, res) => {
    try {
        await ensureStoreReady();
        const region = String(req.query?.region || '').toUpperCase();
        if (!region) {
            return res.status(400).json({ success: false, error: '缺少 region 参数' });
        }
        const addresses = await taxFreeAddress.listAddresses(region);
        res.json({ success: true, addresses });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/addresses', async (req, res) => {
    try {
        await ensureStoreReady();
        const result = await taxFreeAddress.createAddress(req.body);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/addresses/generate-random-us', async (req, res) => {
    try {
        await ensureStoreReady();
        const count = Number(req.body?.count) || 10;
        const result = await taxFreeAddress.batchGenerateUsAddresses(count);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/addresses/unbound', async (req, res) => {
    try {
        await ensureStoreReady();
        const region = String(req.query?.region || 'US').toUpperCase();
        const result = await taxFreeAddress.clearUnboundAddresses(region);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/addresses/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        const result = await taxFreeAddress.updateAddress(id, req.body);
        if (!result.success) {
            const status = result.error === '地址模板不存在' ? 404 : 400;
            return res.status(status).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/addresses/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = req.params.id;
        const result = await taxFreeAddress.deleteAddress(id);
        if (!result.success) {
            return res.status(404).json(result);
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/change-password', async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '').trim();

    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入原密码' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: '新密码至少 6 位' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();

        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '原密码错误' });
        }

        if (verifyPassword(newPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '新密码不能与原密码相同' });
        }

        await store.updateAdminPassword(newPassword);
        await logAdminSecurityEvent('password_changed', {
            ...adminAuth.getClientMeta(req),
            email: req.admin?.email || authConfig.email,
            detail: '登录密码已修改'
        });
        return res.json({ success: true, message: '密码修改成功，请重新登录' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/change-email', async (req, res) => {
    const email = adminAuth.normalizeEmail(req.body?.email);
    const currentPassword = String(req.body?.currentPassword || '');

    if (!email) {
        return res.status(400).json({ success: false, message: '请输入新的管理员邮箱' });
    }
    if (!currentPassword) {
        return res.status(400).json({ success: false, message: '请输入当前登录密码' });
    }

    try {
        await ensureStoreReady();
        const authConfig = await store.getAdminAuthConfig();
        if (!verifyPassword(currentPassword, authConfig.passwordHash)) {
            return res.status(400).json({ success: false, message: '当前登录密码错误' });
        }
        if (email === authConfig.email) {
            return res.status(400).json({ success: false, message: '新邮箱不能与当前邮箱相同' });
        }

        const updated = await store.updateAdminEmail(email);
        await logAdminSecurityEvent('admin_email_changed', {
            ...adminAuth.getClientMeta(req),
            email: updated.email,
            detail: `管理员登录邮箱已由 ${authConfig.email} 修改为 ${updated.email}`
        });
        return res.json({
            success: true,
            email: updated.email,
            message: '管理员登录邮箱已修改，请使用新邮箱重新登录'
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/cdks', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        res.json(await store.listCdks());
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/generate', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const count = req.body?.count;
        const planType = req.body?.plan_type || 'plus';
        const newCdks = createCdks(count);
        const result = await store.insertCdks(newCdks, { type: '自助', plan_type: planType });
        res.json({
            success: true,
            message: `成功生成 ${result.insertedCount} 个自助 CDK`,
            cdks: newCdks,
            insertedCount: result.insertedCount,
            plan_type: planType
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/import', requireSecondaryAuth, async (req, res) => {
    const cdks = Array.isArray(req.body?.cdks) ? req.body.cdks : [];
    if (cdks.length === 0) {
        return res.status(400).json({ success: false, message: '请提供要导入的卡密' });
    }

    try {
        await ensureStoreReady();
        const planType = req.body?.plan_type || 'plus';
        const summary = await store.insertCdks(cdks, { plan_type: planType });
        res.json({
            success: true,
            message: `导入完成，新增 ${summary.insertedCount} 个，重复 ${summary.duplicateCount} 个`,
            ...summary
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/cdks/:cdk/ship', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        const updated = await store.markCdkShipped(req.params.cdk);
        if (!updated) {
            return res.status(404).json({ success: false, message: 'CDK 不存在' });
        }
        res.json({ success: true, message: 'CDK 已标记出库' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/cdks/:cdk', requireSecondaryAuth, async (req, res) => {
    try {
        await ensureStoreReady();
        await store.deleteCdk(req.params.cdk);
        res.json({ success: true, message: 'CDK 已删除' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── Billing Records API ─────────────────────────────────────────────────────

app.get('/api/admin/billing', async (req, res) => {
    try {
        await ensureStoreReady();
        const filters = {};
        if (req.query.start_date) filters.startDate = req.query.start_date;
        if (req.query.end_date) filters.endDate = req.query.end_date;
        if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
        if (req.query.plan_type) filters.planType = req.query.plan_type;
        if (req.query.status) filters.status = req.query.status;
        const page = Math.max(1, Number(req.query.page) || 1);
        const result = await store.listBillingRecords(filters, page, 20);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/billing/export', async (req, res) => {
    try {
        await ensureStoreReady();
        const filters = {};
        if (req.query.start_date) filters.startDate = req.query.start_date;
        if (req.query.end_date) filters.endDate = req.query.end_date;
        if (req.query.card_last4) filters.cardLast4 = req.query.card_last4;
        if (req.query.plan_type) filters.planType = req.query.plan_type;
        if (req.query.status) filters.status = req.query.status;
        const csv = await store.exportBillingRecordsCSV(filters);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="billing_export.csv"');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/billing/summary/:cardLast4', async (req, res) => {
    try {
        await ensureStoreReady();
        const cardLast4 = String(req.params.cardLast4 || '');
        const summary = await store.getCardBillingSummary(cardLast4);
        res.json({ success: true, ...summary });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/billing/failed', async (req, res) => {
    try {
        await ensureStoreReady();
        const deleted = await store.deleteFailedBillingRecords();
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/billing/:id', async (req, res) => {
    try {
        await ensureStoreReady();
        const id = Number(req.params.id);
        if (!id) {
            return res.status(400).json({ success: false, message: '无效的记录 ID' });
        }
        const ok = await store.deleteBillingRecord(id);
        if (!ok) {
            return res.status(404).json({ success: false, message: '账单记录不存在' });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


async function syncBrowserPoolModeFromStore() {
    const enabled = await store.getBrowserPoolEnabled();
    browserPool.setRuntimeEnabled(enabled);
    if (!enabled) {
        await browserPool.shutdownBrowserPool().catch(() => {});
        return { enabled: false, initialized: false, size: 0, mode: 'standalone' };
    }
    const info = await browserPool.initBrowserPool();
    return { ...info, mode: 'pool' };
}

async function spawnWorkerWithBrowser({ jobKey, runtimeEnv, runScript }) {
    const poolEnabled = browserPool.getRuntimeEnabled();
    if (!poolEnabled) {
        logTask(jobKey, '浏览器模式: 独立启动（后台已关闭浏览器池）');
        return runScript(buildWorkerRuntimeEnv(runtimeEnv, null, 'standalone'));
    }
    return browserPool.withBrowserSlot(jobKey, async (poolSlot) => {
        if (poolSlot) {
            logTask(jobKey, `浏览器模式: 池 slot=${poolSlot.slotId} ${poolSlot.cdpUrl}`);
        } else {
            logTask(jobKey, '浏览器模式: 池未就绪，回退独立启动');
        }
        const mode = poolSlot ? 'pool' : 'standalone';
        return runScript(buildWorkerRuntimeEnv(runtimeEnv, poolSlot, mode));
    });
}

function spawnCheckoutDebugWorker({ task, token, sessionRaw, planType, region, planNameOverride, email }) {
    (async () => {
        const checkoutScript = path.join(__dirname, 'index.js');
        try {
            const proxy = await store.getActiveProxy();
            const hcaptchaCfg = await store.getHcaptchaConfig();
            const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
            const runtimeEnv = {
                ...process.env,
                ...hcaptchaEnv,
                CHECKOUT_DEBUG_ONLY: '1',
                CHECKOUT_MODE: 'api',
                CHATGPT_TOKEN: token,
                CHATGPT_SESSION_JSON: String(sessionRaw || '').startsWith('{') ? sessionRaw : '',
                CDK_PLAN_TYPE: planType,
                PAYMENT_REGION_OVERRIDE: region,
                PLAN_NAME_OVERRIDE: planNameOverride || '',
                CDK_CODE: '',
                ACTIVATION_EMAIL: email || '',
                PROXY: proxy
            };

            logTask(task.jobKey, `启动 Playwright 浏览器 proxy=${proxy ? 'yes' : 'no'}`);
            const run = await spawnWorkerWithBrowser({
                jobKey: task.jobKey,
                runtimeEnv,
                runScript: (workerEnv) => runCheckoutScript(task.jobKey, checkoutScript, workerEnv, 1, async (progress) => {
                    if (progress > 0) {
                        await store.updateTaskLog(task.jobKey, {
                            status: 'running',
                            message: '浏览器调试进行中...',
                            progress: Math.min(progress, 99)
                        });
                    }
                })
            });

            const analysis = analyzeCheckoutDebugOutput(run.output, run.timedOut);
            const checkoutUrl = analysis.checkoutUrl || extractCheckoutUrlFromOutput(run.output);
            const failureScreenshots = extractScreenshotsFromOutput(run.output);
            const finalStatus = analysis.status || 'failed';
            const finalProgress = finalStatus === 'success' ? 100 : Math.min(getCheckoutProgress(run.output, finalStatus), 99);
            const finalMessage = finalStatus === 'success' && checkoutUrl
                ? `支付链接: ${checkoutUrl}`
                : (analysis.message || '支付链接调试失败');

            await store.updateTaskLog(task.jobKey, {
                status: finalStatus,
                message: finalMessage,
                rawOutput: run.output,
                progress: finalProgress,
                failureScreenshots
            });

            logTask(
                task.jobKey,
                `调试结束 status=${finalStatus} url=${checkoutUrl ? 'yes' : 'no'} screenshots=${failureScreenshots.length}`
            );
        } catch (error) {
            console.error(`[Checkout Debug] ${task.jobKey}:`, error);
            logTask(task.jobKey, `调试任务异常: ${error.message}`, 'error');
            await store.updateTaskLog(task.jobKey, {
                status: 'failed',
                message: error.message,
                progress: 0
            });
        }
    })();
}

/**
 * 第三方 GPT 代充 API 任务 Worker（协议见 协议api.md）
 *
 * 流程：
 * 1. 读取后台配置（base_url / api_key / plan_key / country / currency / enabled）
 * 2. 从银行卡池预留一张卡作为 new_card（可选，失败则跳过）
 * 3. POST /pay 提交代充（带 Idempotency-Key = `cdk-${cdk}`）
 * 4. 轮询订单/任务状态，直到终态（success / failed）
 * 5. 将结果写回 task_logs（含 gpt_api_order_id / gpt_api_task_id / gpt_api_raw）
 */
const GPT_API_PLAN_MAP = Object.freeze({ plus: 'plus', pro_5x: 'pro5x', pro_20x: 'pro20x' });

function mapGptApiPlanKey(planType) {
    return GPT_API_PLAN_MAP[String(planType || '').trim()] || 'plus';
}

function parseCardExpiry(value) {
    const match = String(value || '').trim().match(/^(0?[1-9]|1[0-2])\s*\/?\s*(\d{2}|\d{4})$/);
    if (!match) throw new Error('银行卡有效期格式错误，应为 MMYY、MM/YY 或 MM/YYYY');
    const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
    return { month: Number(match[1]), year };
}

async function runGptApiWorker({ task, token, session, cdk, planType }) {
    const { jobKey } = task;
    const sessionPayload = session && typeof session === 'object'
        ? session
        : { access_token: token };
    const accountEmail = task.tokenPreview || '';
    let shouldRollbackCdk = true;
    let reservedCard = null;

    const setProgress = async (status, progress, message, extra = {}) => {
        await store.updateTaskLog(jobKey, { status, progress, message, ...extra });
        broadcastToTask(jobKey, {
            type: status === 'running' ? 'progress' : 'status',
            jobKey,
            status,
            progress,
            message,
            cdkCode: cdk
        });
    };

    try {
        const cfg = await store.getGptApiConfig();
        if (!cfg.enabled) {
            throw new Error('第三方代充 API 未启用，请在后台「系统配置」中开启并填写 API 地址与 Key');
        }
        if (!cfg.api_key) {
            throw new Error('第三方代充 API Key 未配置');
        }

        const apiPlanKey = mapGptApiPlanKey(planType);
        await setProgress('running', 10, '正在检查 Session 格式...');
        const inspect = await gptApi.inspectPay(cfg, {
            planKey: apiPlanKey,
            session: sessionPayload
        });
        if (!inspect.success) {
            const statusText = inspect.status ? ` (HTTP ${inspect.status})` : '';
            const detail = [inspect.error, inspect.reason, inspect.upstreamStatus ? `upstream ${inspect.upstreamStatus}` : ''].filter(Boolean).join(' / ');
            throw new Error(`Session 格式或有效期检查失败${statusText}: ${detail || 'session_invalid'}`);
        }
        logTask(jobKey, 'Session 本機格式／有效期檢查通過；上游將於代充任務中驗證登入狀態');

        const proxy = await store.getActiveProxy();
        logTask(jobKey, proxy
            ? `第三方 API 协议代理 ${maskProxyForLog(proxy)}`
            : '第三方 API 使用平台启用代理池');

        // 本機检查通过后才从卡池预留一张卡，避免无效 Session 占用资产。
        let newCard = null;
        reservedCard = await store.reserveCard(`gptapi_${jobKey}`);
        if (!reservedCard) {
            throw new Error('银行卡池暂无可用卡片，请在后台「银行卡池」导入银行卡后再试');
        }
        const expiry = parseCardExpiry(reservedCard.card_expiry);
        newCard = {
            number: reservedCard.card_number,
            exp_month: expiry.month,
            exp_year: expiry.year,
            cvc: reservedCard.card_cvc,
            name: reservedCard.card_holder || 'API User',
            country: cfg.country || 'PH'
        };
        logTask(jobKey, `第三方 API 使用卡池预留卡 ...${String(reservedCard.card_number || '').slice(-4)}`);

        // 套餐从 CDK 的 plan_type 同步；国家币种使用协议默认值（PH / PHP）
        await setProgress('running', 20, '正在提交代充订单...');
        const idempotencyKey = `cdk-${cdk}`;
        const submit = await gptApi.submitPay(cfg, {
            planKey: apiPlanKey,
            session: sessionPayload,
            country: cfg.country,
            currency: cfg.currency,
            newCard,
            proxy,
            clientRef: `kc-cdk-${cdk}-${jobKey}`,
            idempotencyKey
        });

        if (!submit.success) {
            const statusText = submit.status ? ` (HTTP ${submit.status})` : '';
            const detail = submit.error
                || (submit.data && typeof submit.data === 'object' ? JSON.stringify(submit.data).slice(0, 300) : '');
            throw new Error(`代充提交失败${statusText}: ${detail || '未知错误'}`);
        }

        const orderId = submit.orderId || submit.taskId || submit.id;
        const taskId = submit.taskId || null;
        if (!orderId) {
            throw new Error(`代充提交成功但未返回订单号: ${JSON.stringify(submit.data).slice(0, 300)}`);
        }

        await setProgress('running', 35, `代充订单已创建 ${orderId}，正在等待上游处理...`, {
            gptApiOrderId: orderId,
            gptApiTaskId: taskId,
            gptApiRaw: JSON.stringify(submit.data),
            gptApiTopupCode: submit.topupCode
        });

        // 轮询状态
        let finalStatus = 'running';
        let finalMessage = '第三方代充进行中';
        let cardDeclined = false;
        let lastRaw = submit.data;
        const maxPolls = Number(process.env.GPT_API_MAX_POLLS || 120);
        const pollIntervalMs = Number(process.env.GPT_API_POLL_INTERVAL_MS || 5000);

        for (let poll = 1; poll <= maxPolls; poll += 1) {
            await sleep(pollIntervalMs);

            let queryRes = null;
            if (taskId) {
                queryRes = await gptApi.queryTask(cfg, taskId);
            }
            if (!queryRes || !queryRes.success || !queryRes.rawStatus) {
                queryRes = await gptApi.queryOrder(cfg, orderId);
            }

            if (!queryRes || !queryRes.success) {
                logTask(jobKey, `状态轮询第 ${poll} 次失败: ${queryRes?.error || '未知错误'}`, 'warn');
                continue;
            }

            lastRaw = queryRes.data;
            const rawStatus = String(queryRes.rawStatus || '').toLowerCase();
            const progress = Math.min(95, 40 + poll);

            if (isTerminalGptApiStatus(rawStatus)) {
                const businessResult = lastRaw && typeof lastRaw.result === 'object' ? lastRaw.result : {};
                const succeeded = businessResult.ok === false ? false : isSuccessGptApiStatus(rawStatus);
                const failureDetail = businessResult.error || lastRaw?.error || businessResult.status || rawStatus || 'unknown';
                cardDeclined = !succeeded && isPaymentDeclined(String(failureDetail));
                finalStatus = succeeded ? 'success' : 'failed';
                finalMessage = succeeded ? '第三方代充开通成功' : `第三方代充失败: ${failureDetail}`;
                await setProgress(
                    finalStatus,
                    succeeded ? 100 : 99,
                    finalMessage,
                    {
                        gptApiRaw: JSON.stringify(lastRaw),
                        gptApiTopupCode: gptApi.extractTopupCode(lastRaw)
                    }
                );
                break;
            }

            await setProgress('running', progress, `上游处理中 (${rawStatus || 'pending'})...`);
        }

        if (finalStatus === 'running') {
            finalStatus = 'failed';
            finalMessage = '第三方代充超时未完成，请稍后在第三方平台查询订单状态';
            await setProgress(finalStatus, 99, finalMessage, {
                gptApiRaw: JSON.stringify(lastRaw),
                gptApiTopupCode: gptApi.extractTopupCode(lastRaw)
            });
        }

        if (finalStatus === 'success') {
            shouldRollbackCdk = false;
            await store.resetCdkFailure(cdk);
            const usageResult = await store.recordCardUsage(reservedCard?.id);
            await store.releaseCard(reservedCard?.id).catch(() => { });
            if (usageResult.exhausted) {
                logTask(jobKey, `卡 ...${String(reservedCard?.card_number || '').slice(-4)} 已达到订阅绑定上限，已标记为订阅额度用尽`);
            }
            notifyTaskOutcome({ event: 'success', email: accountEmail, cdk, jobKey, message: finalMessage });
        } else {
            if (cardDeclined) {
                const declineResult = await store.recordCardDecline(reservedCard?.id);
                logTask(
                    jobKey,
                    declineResult.exhausted
                        ? `第三方代充明确拒付，卡 ...${String(reservedCard?.card_number || '').slice(-4)} 已达到拒付上限并标记为已报废`
                        : `第三方代充明确拒付，卡 ...${String(reservedCard?.card_number || '').slice(-4)} 拒付计数 ${declineResult.declineCount}`,
                    'warn'
                );
            }
            await store.releaseCard(reservedCard?.id).catch(() => { });
            notifyTaskOutcome({ event: 'failure', email: accountEmail, cdk, jobKey, message: finalMessage });
        }
    } catch (error) {
        console.error(`[GPT API Task Error] ${jobKey}:`, error);
        logTask(jobKey, `第三方代充任务异常: ${error.message}`, 'error');
        await store.releaseCard(reservedCard?.id).catch(() => { });
        await store.updateTaskLog(jobKey, {
            status: 'failed',
            message: error.message,
            progress: 0,
            cdkCode: cdk
        });
        broadcastToTask(jobKey, {
            type: 'status',
            jobKey,
            status: 'failed',
            message: error.message,
            cdkCode: cdk,
            progress: 0
        });
        notifyTaskOutcome({ event: 'failure', email: accountEmail, cdk, jobKey, message: error.message });
    } finally {
        releaseForegroundSlot(jobKey);
        if (shouldRollbackCdk) {
            await store.markCdkUnused(cdk).catch(() => { });
            logTask(jobKey, `CDK ${cdk} 已回滚为未使用`);
        }
        if (getTotalActiveJobs() === 0) {
            const maintenanceModeState = await store.getMaintenanceModeState();
            if (maintenanceModeState.enabled && maintenanceModeState.drain) {
                await store.setMaintenanceModeState(true, false);
            }
        }
    }
}

function maskProxyForLog(proxyUrl) {
    const raw = String(proxyUrl || '');
    try {
        const masked = raw.replace(/\/\/([^@/]+)@/, '//***:***@');
        return masked || '(空)';
    } catch (_) {
        return '(已配置)';
    }
}

const GPT_API_TERMINAL_SUCCESS = new Set(['success', 'succeeded', 'completed', 'paid', 'active', '开通成功', '成功']);
const GPT_API_TERMINAL_FAILED = new Set(['failed', 'declined', 'canceled', 'cancelled', 'error', 'expired', 'rejected', '失败', '取消']);

function isSuccessGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    return [...GPT_API_TERMINAL_SUCCESS].some((kw) => s.includes(kw.toLowerCase()));
}

function isTerminalGptApiStatus(rawStatus) {
    const s = String(rawStatus || '').toLowerCase().trim();
    if (!s) return false;
    if (isSuccessGptApiStatus(s)) return true;
    return [...GPT_API_TERMINAL_FAILED].some((kw) => s.includes(kw.toLowerCase()));
}

function spawnActivationWorker({ task, token, sessionRaw, cdk, cdkDetails, clientIp }) {
    (async () => {
        const checkoutScript = path.join(__dirname, 'index.js');
        let finalRun = null;
        const allOutputs = [];
        let shouldRollbackCdk = true;
        let lastProgress = 0;
        const accountEmail = extractEmailFromSession(sessionRaw) || task.tokenPreview || '';

        try {
            for (let attempt = 1; attempt <= MAX_PROCESS_ATTEMPTS; attempt += 1) {
                logTask(task.jobKey, `开始第 ${attempt}/${MAX_PROCESS_ATTEMPTS} 次尝试`);

                const attemptProgress = normalizeTaskProgress(attempt > 1 ? 1 : 3, 'running', lastProgress);
                broadcastToTask(task.jobKey, {
                    type: 'progress',
                    jobKey: task.jobKey,
                    progress: attemptProgress,
                    status: 'running',
                    message: `正在进行第 ${attempt} 次尝试...`,
                    cdkCode: cdk
                });

                const proxy = await store.getActiveProxy();
                const hcaptchaCfg = await store.getHcaptchaConfig();
                const { env: hcaptchaEnv } = buildHcaptchaEnvFromConfig(hcaptchaCfg);
                const runtimeEnv = {
                    ...process.env,
                    ...hcaptchaEnv,
                    JOB_KEY: task.jobKey,
                    CHATGPT_TOKEN: token,
                    CHATGPT_SESSION_JSON: String(sessionRaw || '').startsWith('{') ? sessionRaw : '',
                    CDK_CODE: cdk,
                    CDK_PLAN_TYPE: cdkDetails.plan_type || 'plus',
                    PROXY: proxy
                };

                logTask(task.jobKey, `尝试 ${attempt} 启动自动化 proxy=${proxy ? 'yes' : 'no'}`);

                const run = await spawnWorkerWithBrowser({
                    jobKey: task.jobKey,
                    runtimeEnv,
                    runScript: (workerEnv) => runCheckoutScript(task.jobKey, checkoutScript, workerEnv, attempt, async (progress, liveOutput) => {
                        if (progress > 0) {
                            const runningProgress = normalizeTaskProgress(progress, 'running', lastProgress);
                            lastProgress = runningProgress;
                            const updatePayload = {
                                status: 'running',
                                message: '正在开通中',
                                rawOutput: null,
                                cdkCode: cdk,
                                progress: runningProgress
                            };
                            if (liveOutput) {
                                const liveMedia = extractTaskMediaFromOutput(liveOutput);
                                const combined = [...liveMedia.screenshots, ...liveMedia.videos];
                                if (combined.length) {
                                    updatePayload.failureScreenshots = combined;
                                }
                            }
                            await store.updateTaskLog(task.jobKey, updatePayload);
                            broadcastToTask(task.jobKey, {
                                type: 'progress',
                                jobKey: task.jobKey,
                                progress: runningProgress,
                                status: 'running',
                                message: '正在开通中',
                                cdkCode: cdk,
                                screenshots: liveOutput ? extractTaskMediaFromOutput(liveOutput).screenshots : undefined,
                                videos: liveOutput ? extractTaskMediaFromOutput(liveOutput).videos : undefined
                            });
                        }
                    })
                });

                const cardLast4 = extractCardLast4FromOutput(run.output);
                allOutputs.push(`===== ATTEMPT ${attempt}${cardLast4 ? ` | CARD ${cardLast4}` : ''} =====\n${run.output}`);
                finalRun = { ...run, output: allOutputs.join('\n\n') };

                const currentStatus = run.analysis.status === 'success' ? 'success' : 'running';
                const currentProgress = normalizeTaskProgress(
                    getCheckoutProgress(run.output, currentStatus),
                    currentStatus,
                    lastProgress
                );
                lastProgress = currentProgress;
                await store.updateTaskLog(task.jobKey, {
                    status: currentStatus,
                    message: currentStatus === 'success' ? '激活成功' : '正在开通中',
                    rawOutput: finalRun.output,
                    progress: currentProgress,
                    cdkCode: cdk,
                    cardLast4
                });

                broadcastToTask(task.jobKey, {
                    type: 'progress',
                    jobKey: task.jobKey,
                    progress: currentProgress,
                    status: currentStatus,
                    message: currentStatus === 'success' ? '激活成功' : '正在开通中',
                    cdkCode: cdk,
                    cardLast4
                });

                if (!run.analysis.shouldRetry || attempt >= MAX_PROCESS_ATTEMPTS) {
                    logTask(task.jobKey, `尝试 ${attempt} 结束，status=${run.analysis.status} shouldRetry=${run.analysis.shouldRetry}`);
                    break;
                }
                logTask(task.jobKey, `尝试 ${attempt} 失败，准备重试`, 'warn');
            }

            const rawOutput = finalRun?.output || '';
            const normalizedAnalysis = finalRun?.analysis?.status === 'retry'
                ? { ...finalRun.analysis, status: 'failed', message: String(finalRun.analysis.message || '激活失败').replace('，准备重试', '') }
                : finalRun?.analysis;
            const finalStatus = normalizedAnalysis?.status || 'failed';

            const finalProgress = normalizeTaskProgress(finalStatus === 'success' ? 100 : lastProgress, finalStatus, lastProgress);
            const taskMedia = extractTaskMediaFromOutput(rawOutput);
            const failureScreenshots = [...taskMedia.screenshots, ...taskMedia.videos];
            await store.updateTaskLog(task.jobKey, {
                status: finalStatus,
                message: normalizedAnalysis?.message || null,
                rawOutput,
                cdkCode: cdk,
                progress: finalProgress,
                failureScreenshots
            });

            broadcastToTask(task.jobKey, {
                type: 'status',
                jobKey: task.jobKey,
                status: finalStatus,
                message: normalizedAnalysis?.message,
                cdkCode: cdk,
                progress: finalProgress,
                screenshots: taskMedia.screenshots,
                videos: taskMedia.videos
            });

            logTask(
                task.jobKey,
                `任务结束 status=${finalStatus} progress=${finalProgress} message=${normalizedAnalysis?.message || ''}`
            );

            if (finalStatus === 'success') {
                shouldRollbackCdk = false;
                await store.resetCdkFailure(cdk);
                if (clientIp) {
                    await store.resetActivationAttemptFailure('ip', clientIp);
                }
                notifyTaskOutcome({
                    event: 'success',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '激活成功'
                });
            } else if (isCardPoolExhaustedIssue(rawOutput, normalizedAnalysis)) {
                notifyTaskOutcome({
                    event: 'card_pool_empty',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '卡池资产枯竭'
                });
            } else if (finalStatus === 'failed' || finalStatus === 'manual') {
                notifyTaskOutcome({
                    event: 'failure',
                    email: accountEmail,
                    cdk,
                    jobKey: task.jobKey,
                    message: normalizedAnalysis?.message || '激活失败'
                });
            }

            if (finalStatus !== 'success' && !normalizedAnalysis?.retainCdk) {
                await store.markCdkUnused(cdk);
                logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
            } else if (normalizedAnalysis?.retainCdk) {
                logTask(task.jobKey, `CDK ${cdk} 已保留，避免已扣款任务被重复发起`);
            }

            if (isNoActivationEligibilityMessage(normalizedAnalysis?.message)) {
                const cdkCooledDown = await store.recordCdkFailure(cdk);
                const ipCooledDown = clientIp
                    ? await store.recordActivationAttemptFailure('ip', clientIp)
                    : false;

                if (cdkCooledDown || ipCooledDown) {
                    const cooldownParts = [];
                    if (cdkCooledDown) {
                        cooldownParts.push('该 CDK 已冷却 10 分钟');
                        logTask(task.jobKey, `CDK ${cdk} 因连续无资格提交进入 10 分钟冷却`, 'warn');
                    }
                    if (ipCooledDown) {
                        cooldownParts.push(`IP ${clientIp} 已冷却 10 分钟`);
                        logTask(task.jobKey, `IP ${clientIp} 因连续无资格提交进入 10 分钟冷却`, 'warn');
                    }
                    const cooldownMessage = `${normalizedAnalysis?.message || '该账号无激活权限,请更换账号重试'}（${cooldownParts.join('，')}）`;
                    await store.updateTaskLog(task.jobKey, {
                        status: finalStatus,
                        message: cooldownMessage,
                        rawOutput,
                        cdkCode: cdk,
                        progress: finalProgress
                    });
                    broadcastToTask(task.jobKey, {
                        type: 'status',
                        jobKey: task.jobKey,
                        status: finalStatus,
                        message: cooldownMessage,
                        cdkCode: cdk,
                        progress: finalProgress
                    });
                }
            }
        } catch (bgError) {
            console.error(`[Background Task Error] ${task.jobKey}:`, bgError);
            logTask(task.jobKey, `后台任务异常: ${bgError.message}`, 'error');
            await store.updateTaskLog(task.jobKey, {
                status: 'failed',
                message: bgError.message,
                rawOutput: bgError.message,
                cdkCode: cdk,
                progress: normalizeTaskProgress(lastProgress, 'failed', lastProgress)
            });
            broadcastToTask(task.jobKey, {
                type: 'status',
                jobKey: task.jobKey,
                status: 'failed',
                message: bgError.message,
                cdkCode: cdk,
                progress: normalizeTaskProgress(lastProgress, 'failed', lastProgress)
            });
            notifyTaskOutcome({
                event: 'failure',
                email: accountEmail,
                cdk,
                jobKey: task.jobKey,
                message: bgError.message
            });
            if (shouldRollbackCdk) {
                await store.markCdkUnused(cdk);
                logTask(task.jobKey, `CDK ${cdk} 已回滚为未使用`);
            }
        } finally {
            releaseForegroundSlot(task.jobKey);
            if (getTotalActiveJobs() === 0) {
                const maintenanceModeState = await store.getMaintenanceModeState();
                if (maintenanceModeState.enabled && maintenanceModeState.drain) {
                    await store.setMaintenanceModeState(true, false);
                }
            }
        }
    })();
}

async function handleActivationRequest(req, res) {
    const rawSession = String(req.body?.session || req.body?.token || '').trim();
    const sessionJson = parseSessionJson(rawSession);
    const token = normalizeSessionToken(rawSession);
    const cdk = String(req.body?.cdk || '').trim();
    const clientIp = getClientIp(req);
    console.log(`[Activation] 收到开通请求 path=${req.path} cdk=${cdk} session_json=${Boolean(sessionJson)} token_len=${token.length}`);
    if (!token) {
        return res.status(400).json({ success: false, message: '缺少 Session JSON 或 AccessToken' });
    }
    if (!cdk) {
        return res.status(400).json({ success: false, message: '缺少 CDK' });
    }
    const tokenCheck = validateAccessToken(token);
    if (!tokenCheck.valid) {
        return res.status(400).json({ success: false, message: tokenCheck.message });
    }

    try {
        await ensureStoreReady();
        const maintenanceModeState = await store.getMaintenanceModeState();
        if (maintenanceModeState.enabled) {
            return res.status(503).json({ success: false, message: '系统维护中，请稍后再试' });
        }
        const maxConcurrentActivations = await store.getMaxConcurrentActivations();
        if (activeForegroundJobs.size >= maxConcurrentActivations) {
            return res.status(429).json({ success: false, message: '当前任务过多，请稍后再试' });
        }

        const cdkDetails = await store.verifyCdkDetails(cdk);
        const runningTask = cdkDetails ? await store.getRunningTaskByCdk(cdk) : null;
        if (runningTask) {
            return res.json({
                success: true,
                jobKey: runningTask.job_key,
                message: runningTask.message || '该 CDK 正在开通中，已为您恢复等待进度'
            });
        }
        if (!cdkDetails || cdkDetails.used_at || cdkDetails.type !== '自助') {
            return res.status(403).json({ success: false, message: 'CDK 无效、已使用或非自助激活码' });
        }

        const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkDetails.cooldown_until);
        if (cdkCooldownMinutes > 0) {
            return res.status(403).json({
                success: false,
                message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
            });
        }

        if (clientIp) {
            const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
            const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
            if (ipCooldownMinutes > 0) {
                return res.status(403).json({
                    success: false,
                    message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                });
            }
        }

        // 判断是否走第三方代充 API 模式（后台「系统配置」开启后生效）
        const gptApiConfig = await store.getGptApiConfig();
        const useGptApi = gptApiConfig.enabled && Boolean(gptApiConfig.api_key);

        if (!useGptApi) {
            const hasCard = await store.hasAvailableCard();
            if (!hasCard) {
                const poolEmail = extractEmailFromSession(rawSession);
                fireTelegramNotification('card_pool_empty', {
                    email: poolEmail,
                    cdk,
                    message: '银行卡池暂无可用卡片，任务未启动'
                });
                return res.status(503).json({
                    success: false,
                    message: '银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试'
                });
            }
        }

        const lockSuccess = await store.markCdkUsed(cdk);
        if (!lockSuccess) {
            return res.status(403).json({ success: false, message: 'CDK 不可用或正在被他人使用' });
        }

        const storedSession = buildStoredSessionPayload(rawSession, sessionJson, token);
        const task = await store.createTaskLog({
            tokenPreview: extractSessionPreview(storedSession),
            sessionPayload: storedSession,
            cdkCode: cdk,
            phone: null,
            cardLast4: null,
            status: 'running',
            progress: 3
        });

        logTask(task.jobKey, `任务已创建，CDK=${cdk} mode=${useGptApi ? 'gpt-api' : 'local'}`);
        reserveForegroundSlot(task.jobKey);

        if (useGptApi) {
            runGptApiWorker({ task, token, session: JSON.parse(storedSession), cdk, planType: cdkDetails.plan_type || 'plus' }).catch((error) => {
                console.error(`[GPT API Worker] ${task.jobKey}:`, error);
            });
        } else {
            spawnActivationWorker({ task, token, sessionRaw: storedSession, cdk, cdkDetails, clientIp });
        }

        return res.json({
            success: true,
            jobKey: task.jobKey,
            message: '任务已启动，正在为您开通中...'
        });
    } catch (error) {
        try { await store.markCdkUnused(cdk); } catch (_) { }
        return res.status(500).json({ success: false, message: error.message });
    }
}

app.post('/api/run-process', handleActivationRequest);

app.post('/api/admin/trigger-activation', handleActivationRequest);

app.post('/api/verify-cdk', async (req, res) => {
    const cdk = String(req.body?.cdk || '').trim();
    const clientIp = getClientIp(req);
    if (!cdk) {
        return res.status(400).json({ success: false, message: '请输入 CDK' });
    }

    try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        const runningTask = cdkData ? await store.getRunningTaskByCdk(cdk) : null;
        if (cdkData && runningTask) {
            return res.json({
                success: true,
                data: {
                    type: cdkData.type || '自助',
                    plan_type: cdkData.plan_type || 'plus',
                    plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus'),
                    status: 'processing',
                    jobKey: runningTask.job_key,
                    message: runningTask.message || '当前 CDK 正在开通中'
                }
            });
        }
        if (cdkData && !cdkData.used_at) {
            if (cdkData.type === '自助') {
                const cdkCooldownMinutes = getRemainingCooldownMinutes(cdkData.cooldown_until);
                if (cdkCooldownMinutes > 0) {
                    return res.status(403).json({
                        success: false,
                        message: `该卡密连续无资格尝试过多，请冷静 ${cdkCooldownMinutes} 分钟后再试`
                    });
                }
                if (clientIp) {
                    const ipAttemptLimit = await store.getActivationAttemptLimit('ip', clientIp);
                    const ipCooldownMinutes = getRemainingCooldownMinutes(ipAttemptLimit?.cooldown_until);
                    if (ipCooldownMinutes > 0) {
                        return res.status(403).json({
                            success: false,
                            message: `当前 IP 连续无资格尝试过多，请冷静 ${ipCooldownMinutes} 分钟后再试`
                        });
                    }
                }
            }
            return res.json({
                success: true,
                data: {
                    type: cdkData.type || '自助',
                    plan_type: cdkData.plan_type || 'plus',
                    plan_label: getPlanTypeLabel(cdkData.plan_type || 'plus')
                }
            });
        }

        return res.status(403).json({ success: false, message: cdkData?.used_at ? '该 CDK 已使用' : '无效 CDK' });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/cdk/query', async (req, res) => {
    const cdk = String(req.query.cdk || '').trim();
    if (!cdk) {
        return res.status(400).json({ success: false, message: '请输入查询激活码' });
    }

    try {
        await ensureStoreReady();
        const cdkData = await store.verifyCdkDetails(cdk);
        if (!cdkData) {
            return res.status(404).json({ success: false, message: '未找到该激活码记录' });
        }

        const runningTask = await store.getRunningTaskByCdk(cdk);
        const cdkStatus = runningTask
            ? '开通中'
            : (cdkData.used_at ? '已使用' : '未使用');

        res.json({
            success: true,
            data: {
                status: cdkStatus,
                type: cdkData.type || '自助',
                createdAt: cdkData.created_at,
                jobKey: runningTask?.job_key || null,
                usedAt: cdkData.used_at
                    ? new Date(cdkData.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
                    : null
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/cdk/download', async (req, res) => {
    return res.status(410).send('成品号下载功能已移除，仅支持自助开通');
});

async function start() {
    await ensureStoreReady();

    try {
        const poolInfo = await syncBrowserPoolModeFromStore();
        if (poolInfo.enabled && poolInfo.initialized !== false) {
            runtimeLog.push({
                jobKey: '',
                level: 'system',
                source: 'server',
                text: `[BrowserPool] 已预热 ${poolInfo.size} 个浏览器槽位`
            });
        } else if (!poolInfo.enabled) {
            runtimeLog.push({
                jobKey: '',
                level: 'system',
                source: 'server',
                text: '[Browser] 独立启动模式（后台已关闭浏览器池）'
            });
        }
    } catch (error) {
        console.error(`[BrowserPool] 初始化失败: ${error.message}`);
    }

    // 启动时把所有遗留的 in_use 锁清空（避免上次崩溃残留的锁卡死整个池）
    try {
        await store.resetAllAssetLocks();
        console.log('🔓 [资产锁] 启动时已重置所有 in_use 标记');
    } catch (error) {
        console.error(`❌ [资产锁] 启动重置失败: ${error.message}`);
    }

    // 每 60 秒兜底回收一次"超过 15 分钟仍未释放"的锁（防进程崩溃）
    setInterval(async () => {
        try {
            const released = await store.releaseStaleAssetLocks();
            if (released.phoneReleased > 0 || released.cardReleased > 0 || released.poolReleased > 0) {
                console.log(`🧹 [资产锁] 兜底回收  phone=${released.phoneReleased}  card=${released.cardReleased}  pool_emails=${released.poolReleased}`);
            }
        } catch (error) {
            console.warn(`⚠️  [资产锁] 周期清理失败: ${error.message}`);
        }
    }, 60 * 1000).unref();

    const server = app.listen(PORT, () => {
        const conn = store.connectionInfo;
        runtimeLog.push({
            jobKey: '',
            level: 'system',
            source: 'server',
            text: `✅ 服务就绪  http://localhost:${PORT}  ·  MySQL ${conn.user}@${conn.host}:${conn.port}/${conn.database}  ·  PID=${process.pid}`
        });
        console.log('数据库表检查完成');
        console.log(`http://localhost:${PORT}`);
        console.log(`MySQL => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`);
    });

    // WebSocket Server Setup
    const wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        let currentJobKey = null;

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === WS_HEARTBEAT_PING_TYPE) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: WS_HEARTBEAT_PONG_TYPE,
                            ts: Number(data.ts) || Date.now()
                        }));
                    }
                    return;
                }
                if (data.type === 'subscribe' && data.jobKey) {
                    if (currentJobKey && currentJobKey !== data.jobKey) {
                        unsubscribeTaskClient(currentJobKey, ws);
                    }
                    currentJobKey = data.jobKey;
                    if (!taskClients.has(currentJobKey)) {
                        taskClients.set(currentJobKey, new Set());
                    }
                    taskClients.get(currentJobKey).add(ws);
                    console.log(`Client subscribed to task: ${currentJobKey}`);
                    await sendTaskSnapshot(ws, currentJobKey);
                }
            } catch (e) {
                console.error('WebSocket message error:', e);
            }
        });

        ws.on('close', () => {
            unsubscribeTaskClient(currentJobKey, ws);
        });
    });
}

if (process.env.IS_PRODUCT_FLOW === 'true') {
    console.log('[系统] 检测到成品子流程环境，跳过 Web 服务监听。');
} else {
    start().catch((error) => {
        console.error('服务启动失败:', error.message);

        if (error && /ECONNREFUSED|connect/i.test(String(error.message || error))) {
            const conn = store.connectionInfo;
            console.error(
                `MySQL 连接配置 => ${conn.user}@${conn.host}:${conn.port}/${conn.database}`
            );
            console.error('排查建议:');
            console.error('1. 确认本机或远程 MySQL 已启动，并且监听了对应 host/port。');
            console.error(`2. 如果不是本机默认库，请先设置环境变量后再启动，例如:`);
            console.error(
                `   $env:DB_HOST='127.0.0.1'; $env:DB_PORT='3306'; $env:DB_USER='root'; $env:DB_PASSWORD='你的密码'; $env:DB_NAME='gpt'; node server.js`
            );
            console.error('3. 首次建库时，请先在 MySQL 中创建数据库，再启动服务自动建表。');
        }

        process.exit(1);
    });
}
