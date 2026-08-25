'use strict';

/**
 * 独立浏览器模式：每任务冷启动 Chromium（不经浏览器池）
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

async function probeUserAgent(browser, fallback = DEFAULT_UA) {
    try {
        const tmpCtx = await browser.newContext();
        const tmpPage = await tmpCtx.newPage();
        const ua = await tmpPage.evaluate(() => navigator.userAgent);
        await tmpCtx.close().catch(() => {});
        return ua || fallback;
    } catch (_) {
        return fallback;
    }
}

/**
 * @param {object} options
 * @param {object} [options.proxyConfig]
 * @param {boolean} [options.headful]
 * @param {string} [options.chromiumChannel]
 * @param {string} [options.cdpPort]
 */
async function connectStandaloneBrowser(options = {}) {
    const headful = options.headful === true;
    const chromiumChannel = String(options.chromiumChannel || '').trim();
    const cdpPort = String(options.cdpPort || process.env.CDP_PORT || '9222').trim();

    const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        `--remote-debugging-port=${cdpPort}`
    ];
    if (!headful || process.env.RUNNING_IN_DOCKER === '1') {
        launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    const launchOptions = {
        headless: !headful,
        args: launchArgs
    };
    if (chromiumChannel) {
        launchOptions.channel = chromiumChannel;
    }
    if (options.proxyConfig) {
        launchOptions.proxy = options.proxyConfig;
    }

    const browser = await chromium.launch(launchOptions);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    if (headful) {
        console.log(`🧪 [Browser/standalone] 有头模式${chromiumChannel ? ` channel=${chromiumChannel}` : ''}`);
    }
    console.log(`🚀 [Browser/standalone] 已启动独立 Chromium (CDP ${cdpUrl})`);

    return {
        mode: 'standalone',
        browser,
        ownsBrowser: true,
        cdpUrl,
        cdpPort,
        realUserAgent: await probeUserAgent(browser)
    };
}

module.exports = {
    connectStandaloneBrowser,
    probeUserAgent,
    DEFAULT_UA
};
