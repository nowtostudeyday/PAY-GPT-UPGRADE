'use strict';

/**
 * 浏览器池：server 进程预热 launchPersistentContext，任务子进程通过 CDP 接入。
 * 每单仍 newContext（隔离 Session/Cookie），仅复用 Chromium 进程与磁盘缓存。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const DEFAULT_POOL_SIZE = 2;
const BASE_PORT = Number(process.env.BROWSER_POOL_BASE_PORT || 19222);
const ACQUIRE_TIMEOUT_MS = Number(process.env.BROWSER_POOL_ACQUIRE_TIMEOUT_MS || 180000);
const MAX_POOL_SIZE = Math.min(48, Math.max(1, Number(process.env.BROWSER_POOL_MAX_SIZE || 24)));

let runtimePoolSizeOverride = null;
let runtimeEnabledOverride = null;

/** @type {Array<{ slotId: number, port: number, cdpUrl: string, persistentContext: import('playwright').BrowserContext, inUse: boolean, jobKey: string|null, uses: number }>} */
let slots = [];
let initialized = false;
let initPromise = null;
/** @type {Array<{ jobKey: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
let waitQueue = [];

function isEnabled() {
    if (runtimeEnabledOverride != null) {
        return Boolean(runtimeEnabledOverride);
    }
    return String(process.env.BROWSER_POOL || '1') !== '0';
}

function setRuntimeEnabled(enabled) {
    runtimeEnabledOverride = Boolean(enabled);
    return runtimeEnabledOverride;
}

function getRuntimeEnabled() {
    if (runtimeEnabledOverride != null) {
        return Boolean(runtimeEnabledOverride);
    }
    return String(process.env.BROWSER_POOL || '1') !== '0';
}

function resolvePoolSize() {
    if (runtimePoolSizeOverride != null) {
        return Math.min(MAX_POOL_SIZE, Math.max(1, Number(runtimePoolSizeOverride) || 1));
    }
    const explicit = Number(process.env.BROWSER_POOL_SIZE || 0);
    if (explicit > 0) {
        return Math.min(MAX_POOL_SIZE, Math.max(1, explicit));
    }
    const concurrent = Number(process.env.MAX_CONCURRENT_ACTIVATIONS || 0);
    if (concurrent > 0) {
        return Math.min(MAX_POOL_SIZE, Math.max(1, concurrent));
    }
    return DEFAULT_POOL_SIZE;
}

function dirSizeBytes(targetPath) {
    let total = 0;
    try {
        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            return stat.size;
        }
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
            total += dirSizeBytes(path.join(targetPath, entry.name));
        }
    } catch (_) { /* ignore */ }
    return total;
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) {
        return `${(n / (1024 ** 3)).toFixed(2)} GB`;
    }
    if (n >= 1024 ** 2) {
        return `${(n / (1024 ** 2)).toFixed(1)} MB`;
    }
    if (n >= 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${n} B`;
}

async function collectSlotDetail(slot) {
    const profileDir = path.join(__dirname, 'data', 'browser-pool', `slot-${slot.slotId}`);
    const profileSizeBytes = dirSizeBytes(profileDir);
    let pageCount = 0;
    const openUrls = [];
    try {
        const pages = slot.persistentContext.pages();
        pageCount = pages.length;
        for (const p of pages.slice(0, 8)) {
            try {
                openUrls.push(p.url() || 'about:blank');
            } catch (_) {
                openUrls.push('<closed>');
            }
        }
    } catch (_) { /* ignore */ }

    return {
        slotId: slot.slotId,
        port: slot.port,
        inUse: slot.inUse,
        jobKey: slot.jobKey,
        uses: slot.uses,
        cdpUrl: slot.cdpUrl,
        profileDir,
        profileSizeBytes,
        profileSizeText: formatBytes(profileSizeBytes),
        pageCount,
        openUrls,
        uptimeSec: Math.max(0, Math.floor((Date.now() - slot.createdAt) / 1000))
    };
}

function buildLaunchArgs(port) {
    const args = [
        '--disable-blink-features=AutomationControlled',
        `--remote-debugging-port=${port}`
    ];
    if (process.env.HEADFUL !== '1' || process.env.RUNNING_IN_DOCKER === '1') {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
    return args;
}

async function warmSlot(slotId) {
    const port = BASE_PORT + slotId;
    const profileDir = path.join(__dirname, 'data', 'browser-pool', `slot-${slotId}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const launchOptions = {
        headless: process.env.HEADFUL !== '1',
        args: buildLaunchArgs(port),
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/Chicago',
        ignoreHTTPSErrors: true
    };
    const channel = String(process.env.CHROMIUM_CHANNEL || '').trim();
    if (channel) {
        launchOptions.channel = channel;
    }

    const persistentContext = await chromium.launchPersistentContext(profileDir, launchOptions);
    return {
        slotId,
        port,
        cdpUrl: `http://127.0.0.1:${port}`,
        persistentContext,
        inUse: false,
        jobKey: null,
        uses: 0,
        createdAt: Date.now()
    };
}

async function initBrowserPool() {
    if (!isEnabled()) {
        console.log('[BrowserPool] 已禁用 (BROWSER_POOL=0)');
        return { enabled: false, size: 0 };
    }
    if (initialized) {
        return { enabled: true, size: slots.length };
    }
    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        const size = resolvePoolSize();
        console.log(`[BrowserPool] 正在预热 ${size} 个浏览器槽位 (CDP ${BASE_PORT}..${BASE_PORT + size - 1})...`);
        const created = [];
        for (let i = 0; i < size; i += 1) {
            try {
                const slot = await warmSlot(i);
                created.push(slot);
                console.log(`[BrowserPool] ✅ slot-${i} 就绪 ${slot.cdpUrl}`);
            } catch (error) {
                console.error(`[BrowserPool] ❌ slot-${i} 启动失败: ${error.message}`);
            }
        }
        slots = created;
        initialized = created.length > 0;
        if (!initialized) {
            console.warn('[BrowserPool] 无可用槽位，任务将回退为每次冷启动浏览器');
        } else {
            console.log(`[BrowserPool] 预热完成 ${created.length}/${size} 个槽位`);
        }
        return { enabled: initialized, size: created.length };
    })();

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

function getStats() {
    return {
        enabled: isEnabled(),
        initialized,
        configuredSize: resolvePoolSize(),
        maxPoolSize: MAX_POOL_SIZE,
        basePort: BASE_PORT,
        acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
        size: slots.length,
        idle: slots.filter((s) => !s.inUse).length,
        busy: slots.filter((s) => s.inUse).length,
        waiting: waitQueue.length,
        totalUses: slots.reduce((sum, s) => sum + Number(s.uses || 0), 0),
        slots: slots.map((s) => ({
            slotId: s.slotId,
            port: s.port,
            inUse: s.inUse,
            jobKey: s.jobKey,
            uses: s.uses,
            cdpUrl: s.cdpUrl
        }))
    };
}

async function getDetailedStats(hostMemory = null) {
    const slotDetails = await Promise.all(slots.map((s) => collectSlotDetail(s)));
    const profileBytes = slotDetails.reduce((sum, s) => sum + Number(s.profileSizeBytes || 0), 0);
    const estimatedProcessMb = slots.length * 420;
    const hostTotalGb = hostMemory?.totalGb ?? null;
    const hostUsedGb = hostMemory?.usedGb ?? null;
    const hostFreeGb = hostTotalGb != null && hostUsedGb != null
        ? Math.max(0, hostTotalGb - hostUsedGb)
        : null;

    let sizingHint = '默认每槽约 400–550MB 内存；建议池大小 ≤ 可用内存 / 0.5GB';
    if (hostFreeGb != null) {
        const suggested = Math.min(MAX_POOL_SIZE, Math.max(1, Math.floor(hostFreeGb / 0.55)));
        sizingHint = `按当前可用约 ${hostFreeGb.toFixed(1)}GB，建议池大小 ≤ ${suggested}（上限 ${MAX_POOL_SIZE}）`;
    }

    return {
        ...getStats(),
        queue: waitQueue.map((w) => ({ jobKey: w.jobKey || '' })),
        slots: slotDetails,
        totals: {
            profileBytes,
            profileSizeText: formatBytes(profileBytes),
            estimatedProcessMb,
            estimatedProcessText: `~${estimatedProcessMb} MB`
        },
        memory: {
            hostTotalGb,
            hostUsedGb,
            hostFreeGb,
            sizingHint
        },
        runtimeOverride: runtimePoolSizeOverride
    };
}

async function reloadBrowserPool(requestedSize = null) {
    const busy = slots.filter((s) => s.inUse).length;
    if (busy > 0) {
        throw new Error(`当前有 ${busy} 个槽位使用中，请待任务结束后再热重载`);
    }
    if (requestedSize != null && Number(requestedSize) > 0) {
        runtimePoolSizeOverride = Math.min(MAX_POOL_SIZE, Math.max(1, Number(requestedSize)));
    }
    await shutdownBrowserPool();
    return initBrowserPool();
}

function setRuntimePoolSize(size) {
    const n = Math.min(MAX_POOL_SIZE, Math.max(1, Number(size) || 1));
    runtimePoolSizeOverride = n;
    return n;
}

function releaseSlot(slotId) {
    const slot = slots.find((s) => s.slotId === slotId);
    if (!slot) {
        return;
    }
    slot.inUse = false;
    slot.jobKey = null;

    if (!waitQueue.length) {
        return;
    }
    const free = slots.find((s) => !s.inUse);
    if (!free) {
        return;
    }
    const next = waitQueue.shift();
    clearTimeout(next.timer);
    free.inUse = true;
    free.jobKey = next.jobKey;
    free.uses += 1;
    next.resolve({
        slotId: free.slotId,
        cdpUrl: free.cdpUrl,
        port: free.port
    });
}

function acquireSlot(jobKey) {
    return new Promise((resolve, reject) => {
        if (!initialized || !slots.length) {
            resolve(null);
            return;
        }
        const free = slots.find((s) => !s.inUse);
        if (free) {
            free.inUse = true;
            free.jobKey = jobKey || '';
            free.uses += 1;
            resolve({
                slotId: free.slotId,
                cdpUrl: free.cdpUrl,
                port: free.port
            });
            return;
        }

        const entry = {
            jobKey: jobKey || '',
            resolve,
            reject,
            timer: setTimeout(() => {
                const idx = waitQueue.indexOf(entry);
                if (idx >= 0) {
                    waitQueue.splice(idx, 1);
                }
                reject(new Error(`浏览器池繁忙，${Math.round(ACQUIRE_TIMEOUT_MS / 1000)}s 内无空闲槽位`));
            }, ACQUIRE_TIMEOUT_MS)
        };
        waitQueue.push(entry);
    });
}

async function withBrowserSlot(jobKey, fn) {
    if (!isEnabled() || !initialized || !slots.length) {
        return fn(null);
    }
    const slot = await acquireSlot(jobKey);
    if (!slot) {
        return fn(null);
    }
    try {
        return await fn(slot);
    } finally {
        releaseSlot(slot.slotId);
    }
}

function buildPoolEnv(slot) {
    if (!slot) {
        return {};
    }
    return {
        BROWSER_POOL: '1',
        BROWSER_POOL_SLOT: String(slot.slotId),
        BROWSER_POOL_CDP_URL: slot.cdpUrl,
        CDP_URL: slot.cdpUrl,
        CDP_PORT: String(slot.port)
    };
}

async function shutdownBrowserPool() {
    for (const waiter of waitQueue) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('浏览器池正在关闭'));
    }
    waitQueue = [];

    for (const slot of slots) {
        try {
            await slot.persistentContext.close();
        } catch (_) { /* ignore */ }
    }
    slots = [];
    initialized = false;
}

module.exports = {
    initBrowserPool,
    shutdownBrowserPool,
    reloadBrowserPool,
    setRuntimePoolSize,
    setRuntimeEnabled,
    getRuntimeEnabled,
    withBrowserSlot,
    buildPoolEnv,
    getStats,
    getDetailedStats,
    isEnabled,
    acquireSlot,
    releaseSlot,
    formatBytes,
    MAX_POOL_SIZE
};
