'use strict';

const { getRegionConfig } = require('./region-config');
const { assertChatGptLoggedIn } = require('./session-auth');
const { clearHumanVerification } = require('./human-verification');

const PRICING_URL = 'https://chatgpt.com/#pricing';

const REGION_UI_LABELS = {
    PH: ['菲律宾', 'Philippines', 'Pilipinas'],
    US: ['美国', 'United States'],
    SG: ['新加坡', 'Singapore'],
    MY: ['马来西亚', 'Malaysia']
};

const REGION_CURRENCY_HINTS = {
    PH: ['₱'],
    US: ['$20', '$ 20'],
    SG: ['S$', 'SGD'],
    MY: ['RM', 'MYR']
};

const REGION_PRICE_PATTERNS = {
    PH: [/₱\s*[\d,.]+/, /[\d,.]+\s*₱/],
    US: [/\$\s*20(?:\.00)?/, /USD\s*20/i, /\$\s*[\d,.]+(?:\s*\/)?\s*(?:month|mo)/i],
    SG: [/S\$\s*[\d,.]+/, /[\d,.]+\s*SGD/i],
    MY: [/RM\s*[\d,.]+/, /[\d,.]+\s*MYR/i]
};

const REGION_WRONG_CURRENCY = {
    PH: [/£\s*[\d,.]+/, /[\d,.]+\s*£/, /\bGBP\b/i, /United Kingdom/i, /Great Britain/i, /€\s*[\d,.]+/, /[\d,.]+\s*€/, /\bEUR\b/i],
    US: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\bGBP\b/i, /\bPHP\b/i, /S\$\s*[\d,.]+/, /RM\s*[\d,.]+/],
    SG: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /\$\s*20(?:\.00)?\s*(?:USD|\/)/i, /RM\s*[\d,.]+/],
    MY: [/£\s*[\d,.]+/, /₱\s*[\d,.]+/, /S\$\s*[\d,.]+/, /\$\s*20(?:\.00)?/]
};

const REGION_CURRENT_COUNTRY_HINTS = {
    PH: [/菲律宾|Philippines|Pilipinas/i],
    US: [/United States|美国(?!地区)/i],
    SG: [/Singapore|新加坡/i],
    MY: [/Malaysia|马来西亚/i]
};

const SKIP_REGION_BUTTON_TEXT = /^(Upgrade|Personal|Business|Free|Plus|Pro|Subscribe|Close|Your current plan|升级|订阅|关闭)$/i;

const PLAN_UPGRADE_TEST_IDS = Object.freeze({
    plus: 'select-plan-button-plus-upgrade',
    pro_5x: 'select-plan-button-pro-upgrade',
    pro_20x: 'select-plan-button-pro-upgrade'
});

const PRICING_PAGE_INITIAL_WAIT_MS = 5000;
const PRICING_PAGE_READY_TIMEOUT_MS = 10000;

const PRO_VARIANTS = Object.freeze({
    pro_5x: { checkoutValue: 'chatgptprolite', pricingRadioLabel: '5x' },
    pro_20x: { checkoutValue: 'chatgptpro', pricingRadioLabel: '20x' }
});

const resolvePlanUpgradeTestId = (planType) => {
    const plan = String(planType).trim().toLowerCase();
    const testId = PLAN_UPGRADE_TEST_IDS[plan];
    if (!testId) {
        throw new Error(`不支持 UI 定价页套餐: ${plan}`);
    }
    return testId;
};

const getUniqueVisiblePlanButton = async (page, planType) => {
    const plan = String(planType).trim().toLowerCase();
    const testId = resolvePlanUpgradeTestId(plan);
    const button = page.getByTestId(testId);
    const count = await button.count();
    if (count !== 1) {
        throw new Error(`定价页套餐按钮数量异常: ${plan} / ${testId} / ${count}`);
    }
    if (!(await button.isVisible({ timeout: 4000 }))) {
        throw new Error(`定价页套餐按钮不可见: ${plan} / ${testId}`);
    }
    return { plan, testId, button };
};

const isPricingPlanSelectorVisible = async (page, planType) => {
    const testIds = typeof planType === 'string'
        ? [resolvePlanUpgradeTestId(planType)]
        : [...new Set(Object.values(PLAN_UPGRADE_TEST_IDS))];
    for (const testId of testIds) {
        const button = page.getByTestId(testId);
        if ((await button.count()) !== 1) {
            continue;
        }
        if (await button.isVisible({ timeout: 500 }).catch(() => false)) {
            return true;
        }
    }
    return false;
};

const waitForPricingPlanSelector = async (page, planType) => {
    const deadline = Date.now() + PRICING_PAGE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isPricingPlanSelectorVisible(page, planType)) {
            return;
        }
        await page.waitForTimeout(500);
    }
    const planDescription = typeof planType === 'string' ? ` (${planType})` : '';
    throw new Error(`定价页未展示套餐选择按钮${planDescription}，当前 URL: ${page.url()}`);
};

const getProVariant = (planType) => PRO_VARIANTS[String(planType).trim().toLowerCase()];

const selectProVariantOnPricingPage = async (page, planType) => {
    const plan = String(planType).trim().toLowerCase();
    const variant = getProVariant(plan);
    if (!variant) {
        return false;
    }

    const radio = page.getByRole('radio', { name: variant.pricingRadioLabel, exact: true });
    const count = await radio.count();
    if (count === 0) {
        return false;
    }
    if (count !== 1) {
        throw new Error(`定价页 Pro 档位按钮数量异常: ${plan} / ${variant.pricingRadioLabel} / ${count}`);
    }
    if (!(await radio.isVisible({ timeout: 4000 }))) {
        throw new Error(`定价页 Pro 档位按钮不可见: ${plan} / ${variant.pricingRadioLabel}`);
    }

    await radio.click({ timeout: 10000 });
    await page.waitForTimeout(300);
    if (await radio.getAttribute('aria-checked') !== 'true') {
        throw new Error(`定价页 Pro 档位未选中: ${plan} / ${variant.pricingRadioLabel}`);
    }
    console.log(`✅ [步骤] 定价页已选择 Pro 档位: ${plan} (${variant.pricingRadioLabel})`);
    return true;
};

const selectProVariantOnCheckoutPage = async (page, planType) => {
    const plan = String(planType).trim().toLowerCase();
    const variant = getProVariant(plan);
    if (!variant) {
        return;
    }

    const option = page.locator(`#${variant.checkoutValue}`);
    const count = await option.count();
    if (count !== 1) {
        throw new Error(`Checkout Pro 档位按钮数量异常: ${plan} / ${variant.checkoutValue} / ${count}`);
    }
    if (!(await option.isVisible({ timeout: 4000 }))) {
        throw new Error(`Checkout Pro 档位按钮不可见: ${plan} / ${variant.checkoutValue}`);
    }
    const role = await option.getAttribute('role');
    const value = await option.getAttribute('value');
    if (role !== 'radio' || value !== variant.checkoutValue) {
        throw new Error(`Checkout Pro 档位标识不匹配: ${plan} / ${variant.checkoutValue}`);
    }

    await option.click({ timeout: 10000 });
    await page.waitForTimeout(300);
    const ariaChecked = await option.getAttribute('aria-checked');
    const dataState = await option.getAttribute('data-state');
    if (ariaChecked !== 'true' || dataState !== 'checked') {
        throw new Error(`Checkout Pro 档位未确认选中: ${plan} / ${variant.checkoutValue}`);
    }
    console.log(`✅ [步骤] Checkout 已确认 Pro 档位: ${plan} (${variant.checkoutValue})`);
};

function normalizeOptionText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function matchesCountryLabel(text, labels) {
    const normalized = normalizeOptionText(text).toLowerCase();
    return labels.some((label) => normalized === String(label).toLowerCase());
}

async function isBusinessTabActive(page) {
    const businessTab = page.getByRole('tab', { name: /^Business$/i }).first();
    if (await businessTab.isVisible({ timeout: 800 }).catch(() => false)) {
        const selected = await businessTab.getAttribute('aria-selected').catch(() => null);
        const state = await businessTab.getAttribute('data-state').catch(() => null);
        if (selected === 'true' || state === 'active') {
            return true;
        }
    }

    const businessCard = await page.getByText(/ChatGPT Business/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const plusCard = await page.getByText(/^ChatGPT Plus$/i).first().isVisible({ timeout: 500 }).catch(() => false);
    return businessCard && !plusCard;
}

async function isPersonalPlanView(page) {
    if (await isBusinessTabActive(page)) {
        return false;
    }

    const plusCard = await page.locator('[role="dialog"]').locator('div').filter({
        hasText: /ChatGPT Plus|^Plus$/
    }).filter({
        has: page.getByRole('button', { name: /Upgrade|升级|Subscribe|Get/i })
    }).first().isVisible({ timeout: 1000 }).catch(() => false);

    if (plusCard) {
        return true;
    }

    const plusTitle = await page.getByText(/^ChatGPT Plus$/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const plusBtn = await page.getByRole('button', { name: /Upgrade to Plus|升级至\s*Plus|Get Plus|Subscribe to Plus/i })
        .first()
        .isVisible({ timeout: 800 })
        .catch(() => false);
    return plusTitle || plusBtn;
}

async function isBusinessPlanView(page) {
    const businessTitle = await page.getByText(/ChatGPT Business/i).first().isVisible({ timeout: 800 }).catch(() => false);
    const onPersonal = await isPersonalPlanView(page);
    return businessTitle && !onPersonal;
}

/**
 * 定价页顶部 Personal / Business 切换（Plus/Pro 都在 Personal 下）
 */
async function switchToPersonalPlans(page) {
    if (await isPersonalPlanView(page)) {
        console.log('✅ [步骤] 已在个人套餐 (Personal) 视图');
        return;
    }

    if (await isBusinessTabActive(page)) {
        console.log('🔄 [步骤] 检测到 Business 标签，正在切换到 Personal...');
    } else {
        console.log('🔄 [步骤] 正在切换到「个人 / Personal」套餐...');
    }

    const personalCandidates = [
        () => page.getByRole('tab', { name: /^Personal$/i }).first(),
        () => page.getByRole('tab', { name: /^个人$/ }).first(),
        () => page.getByRole('button', { name: /^Personal$/i }).first(),
        () => page.getByRole('button', { name: /^个人$/ }).first(),
        () => page.getByRole('radio', { name: /^Personal$/i }).first(),
        () => page.locator('[role="tablist"] [role="tab"]').filter({ hasText: /^Personal$/i }).first(),
        () => page.locator('button').filter({ hasText: /^Personal$/ }).first(),
        () => page.locator('[role="dialog"]').getByText('Personal', { exact: true }).first(),
        () => page.getByText('Personal', { exact: true }).first()
    ];

    for (const getLocator of personalCandidates) {
        try {
            const el = getLocator();
            if (await el.isVisible({ timeout: 1200 })) {
                const selected = await el.getAttribute('aria-selected').catch(() => null);
                const pressed = await el.getAttribute('aria-pressed').catch(() => null);
                if (selected === 'true' || pressed === 'true') {
                    console.log('✅ [步骤] Personal 标签已选中');
                    return;
                }
                await el.scrollIntoViewIfNeeded().catch(() => {});
                await el.click({ timeout: 8000 });
                await page.waitForTimeout(1800);
                if (await isPersonalPlanView(page)) {
                    console.log('✅ [步骤] 已切换到个人套餐 (Personal)');
                    return;
                }
            }
        } catch (_) { /* try next */ }
    }

    if (await isBusinessPlanView(page)) {
        throw new Error('定价页停留在 Business 套餐，未能切换到 Personal，无法购买 Plus/Pro');
    }

    console.warn('[Warn] 未能确认 Personal 切换，将继续查找升级按钮');
}

async function getPricingSurface(page) {
    const dialog = page.locator('[role="dialog"]').first();
    if (await dialog.isVisible({ timeout: 2000 }).catch(() => false)) {
        return dialog;
    }
    return page.locator('main').first();
}

async function readPricingSurfaceText(page) {
    const surface = await getPricingSurface(page);
    return String(await surface.innerText({ timeout: 5000 }).catch(() => '') || '');
}

async function scrollPricingSurface(page) {
    const surface = await getPricingSurface(page);
    await surface.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
    }).catch(() => {});
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await page.waitForTimeout(600);
}

async function pageShowsTargetRegionPricing(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const text = await readPricingSurfaceText(page);
    const positive = REGION_PRICE_PATTERNS[code] || [];
    const negative = REGION_WRONG_CURRENCY[code] || [];
    const countryHints = REGION_CURRENT_COUNTRY_HINTS[code] || [];

    const hasPositivePrice = positive.some((pattern) => pattern.test(text));
    const hasWrongCurrency = negative.some((pattern) => pattern.test(text));
    const hasCountryLabel = countryHints.some((pattern) => pattern.test(text));

    if (hasWrongCurrency) {
        return false;
    }
    if (hasPositivePrice) {
        return true;
    }
    if (hasCountryLabel && !hasWrongCurrency) {
        const looseHints = REGION_CURRENCY_HINTS[code] || [];
        if (looseHints.some((hint) => text.includes(hint))) {
            return true;
        }
    }
    return false;
}

const ALL_COUNTRY_NAME_PATTERN = /^(United Kingdom|Philippines|United States|Singapore|Malaysia|Afghanistan|Algeria|Andorra|Albania|Australia|Canada|Japan|China|菲律宾)$/i;

async function isRegionMenuOpen(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 500 }).catch(() => false)) {
        return true;
    }
    return false;
}

async function closeRegionMenuIfOpen(page) {
    if (!(await isRegionMenuOpen(page))) {
        return;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
}

async function openRegionPicker(page) {
    if (await isRegionMenuOpen(page)) {
        console.log('[Info] 地区选择器已打开');
        return true;
    }

    const surface = await getPricingSurface(page);
    await scrollPricingSurface(page);

    const triggerCandidates = [
        surface.locator('button[aria-haspopup="listbox"]').last(),
        surface.locator('button[aria-haspopup="listbox"]').first(),
        surface.locator('button[aria-haspopup="menu"]').last(),
        surface.locator('button[aria-expanded]').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last(),
        surface.locator('[role="dialog"] button').filter({ hasText: ALL_COUNTRY_NAME_PATTERN }).last()
    ];

    for (const trigger of triggerCandidates) {
        try {
            if (!(await trigger.isVisible({ timeout: 1200 }).catch(() => false))) {
                continue;
            }
            const inListbox = await trigger.evaluate((node) => Boolean(node.closest('[role="listbox"]'))).catch(() => false);
            if (inListbox) {
                continue;
            }
            const text = normalizeOptionText(await trigger.innerText().catch(() => ''));
            if (!text || SKIP_REGION_BUTTON_TEXT.test(text)) {
                continue;
            }
            await trigger.scrollIntoViewIfNeeded().catch(() => {});
            await trigger.click({ timeout: 8000 });
            await page.waitForTimeout(900);
            if (await isRegionMenuOpen(page)) {
                console.log(`[Info] 已打开地区选择器 (${text.slice(0, 40)})`);
                return true;
            }
        } catch (_) { /* try next */ }
    }

    return false;
}

async function getCountryScrollViewport(page) {
    const viewport = page.locator('[data-radix-scroll-area-viewport]').last();
    if (await viewport.isVisible({ timeout: 1000 }).catch(() => false)) {
        return viewport;
    }

    const listbox = page.locator('[role="listbox"]').first();
    if (await listbox.isVisible({ timeout: 1000 }).catch(() => false)) {
        return listbox;
    }

    return null;
}

async function clickExactCountryInViewport(viewport, labels) {
    return viewport.evaluate((root, labelList) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = labelList.map(normalize);
        const elements = Array.from(root.querySelectorAll('[role="option"], [data-index], button, li, div'));

        for (const el of elements) {
            if (!root.contains(el)) {
                continue;
            }
            const lines = String(el.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
            if (lines.length !== 1) {
                continue;
            }
            const text = normalize(lines[0]);
            if (!wanted.includes(text)) {
                continue;
            }
            const childHasSame = Array.from(el.children).some((child) => {
                const childLines = String(child.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
                return childLines.length === 1 && normalize(childLines[0]) === text;
            });
            if (childHasSame) {
                continue;
            }
            el.scrollIntoView({ block: 'center' });
            el.click();
            return lines[0];
        }
        return '';
    }, labels).catch(() => '');
}

async function scrollVirtualCountryList(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        console.warn('[Warn] 未找到可滚动的国家列表容器');
        return false;
    }

    await viewport.evaluate((node) => {
        node.scrollTop = 0;
    }).catch(() => {});
    await page.waitForTimeout(250);

    const jumpRatio = targets.some((label) => /philippines|pilipinas|菲律宾/i.test(label)) ? 0.58 : 0.5;
    await viewport.evaluate((node, ratio) => {
        node.scrollTop = Math.floor(node.scrollHeight * ratio);
    }, jumpRatio).catch(() => {});
    await page.waitForTimeout(300);

    for (let step = 0; step < 160; step += 1) {
        for (const label of targets) {
            const opt = viewport.getByText(new RegExp(`^${escapeRegExp(label)}$`, 'i')).first();
            if ((await opt.count()) > 0) {
                try {
                    await opt.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
                    if (await opt.isVisible({ timeout: 300 }).catch(() => false)) {
                        await opt.click({ timeout: 8000 });
                        console.log(`✅ [步骤] Playwright 文本匹配选中: ${label}`);
                        return true;
                    }
                } catch (_) { /* continue scrolling */ }
            }
        }

        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 虚拟列表第 ${step + 1} 步选中: ${picked}`);
            return true;
        }

        const visibleTexts = await viewport.evaluate((root) => {
            return Array.from(root.querySelectorAll('[role="option"], button, li'))
                .map((el) => String(el.innerText || '').split('\n')[0].trim())
                .filter(Boolean)
                .slice(0, 8);
        }).catch(() => []);
        if (step === 0 || step % 15 === 0) {
            console.log(`[Info] 滚动第 ${step + 1} 步，可见: ${visibleTexts.join(' | ') || '(empty)'}`);
        }

        const atBottom = await viewport.evaluate((node) => {
            const before = node.scrollTop;
            node.scrollTop += Math.max(72, Math.floor(node.clientHeight * 0.32));
            return node.scrollTop <= before;
        }).catch(() => true);

        await page.waitForTimeout(90);
        if (atBottom) {
            break;
        }
    }

    await viewport.hover().catch(() => {});
    for (let wheel = 0; wheel < 80; wheel += 1) {
        const picked = await clickExactCountryInViewport(viewport, targets);
        if (picked) {
            console.log(`✅ [步骤] 滚轮后选中: ${picked}`);
            return true;
        }
        await page.mouse.wheel(0, 280);
        await page.waitForTimeout(60);
    }

    return false;
}

async function scrollAndSelectCountryOption(page, labels) {
    const targets = (labels || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!targets.length) {
        return false;
    }

    if (!(await isRegionMenuOpen(page))) {
        return false;
    }

    console.log(`[Info] 开始在虚拟列表中查找: ${targets.join(' / ')}`);

    if (await scrollVirtualCountryList(page, targets)) {
        return true;
    }

    for (const label of targets) {
        if (await tryKeyboardCountryFilter(page, label)) {
            return true;
        }
    }

    return false;
}

async function clickRegionOption(page, label) {
    if (await scrollAndSelectCountryOption(page, [label])) {
        return true;
    }

    const optionLocators = [
        page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.getByRole('menuitem', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('radio', { name: new RegExp(escapeRegExp(label), 'i') }),
        page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }),
        page.locator(`[role="option"]:has-text("${label}")`),
        page.locator(`[role="menuitem"]:has-text("${label}")`),
        page.locator(`li:has-text("${label}")`)
    ];

    for (const locator of optionLocators) {
        try {
            const el = locator.first();
            if ((await el.count()) === 0) {
                continue;
            }
            await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
            if (await el.isVisible({ timeout: 1200 })) {
                await el.click({ timeout: 8000 });
                return true;
            }
        } catch (_) { /* try next */ }
    }
    return false;
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryKeyboardCountryFilter(page, label) {
    const typeText = String(label || '').trim();
    if (!typeText) {
        return false;
    }

    const viewport = await getCountryScrollViewport(page);
    if (!viewport) {
        return false;
    }

    try {
        await viewport.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(150);
        await page.keyboard.press('Home').catch(() => {});
        await page.waitForTimeout(100);
        await page.keyboard.type(typeText, { delay: 60 });
        await page.waitForTimeout(500);

        const picked = await clickExactCountryInViewport(viewport, [label]);
        if (picked) {
            console.log(`✅ [步骤] 键盘筛选后已选择: ${picked}`);
            return true;
        }

        const option = page.getByRole('option', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }).first();
        if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
            await option.click({ timeout: 8000 });
            console.log(`✅ [步骤] 键盘筛选后已选择: ${label}`);
            return true;
        }
    } catch (_) { /* ignore */ }

    return false;
}

async function readSelectedCountryLabel(page) {
    const surface = await getPricingSurface(page);
    const trigger = surface.locator('button').filter({
        hasText: /Philippines|United Kingdom|Algeria|United States|Singapore|Malaysia|Afghanistan|菲律宾/i
    }).last();
    if (await trigger.isVisible({ timeout: 1000 }).catch(() => false)) {
        return normalizeOptionText(await trigger.innerText().catch(() => ''));
    }
    return '';
}

async function selectRegionOption(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const labels = REGION_UI_LABELS[code] || [];
    const preferredLabels = labels.filter((label) => label.length > 2);

    const search = page.locator('input[type="search"], input[placeholder*="Search" i], input[placeholder*="搜索" i]').first();
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
        for (const label of preferredLabels) {
            await search.fill('').catch(() => {});
            await search.fill(label).catch(() => {});
            await page.waitForTimeout(700);
            const viewport = await getCountryScrollViewport(page);
            const picked = viewport
                ? await clickExactCountryInViewport(viewport, [label])
                : '';
            if (picked) {
                console.log(`✅ [步骤] 已通过搜索框选择地区: ${picked}`);
                return verifySelectedCountry(page, preferredLabels);
            }
        }
    }

    if (await scrollAndSelectCountryOption(page, preferredLabels)) {
        return verifySelectedCountry(page, preferredLabels);
    }

    return false;
}

async function verifySelectedCountry(page, labels) {
    await page.waitForTimeout(800);
    const selected = await readSelectedCountryLabel(page);
    if (selected && matchesCountryLabel(selected, labels)) {
        console.log(`✅ [步骤] 地区选择已确认: ${selected}`);
        return true;
    }
    if (selected) {
        console.warn(`[Warn] 地区选择校验失败，当前显示: ${selected}，期望: ${labels.join(' / ')}`);
        return false;
    }
    return true;
}

/** @deprecated 使用 pageShowsTargetRegionPricing */
async function pageShowsCurrency(page, regionCode) {
    return pageShowsTargetRegionPricing(page, regionCode);
}

async function waitForPricingPage(page, timeout = 60000) {
    await page.goto(PRICING_URL, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(PRICING_PAGE_INITIAL_WAIT_MS);

    await clearHumanVerification(page, { phase: 'pricing-page', maxWaitMs: 120000 });

    await assertChatGptLoggedIn(page, '定价页');

    const url = page.url();
    if (!url.includes('chatgpt.com')) {
        throw new Error(`定价页打开失败，当前 URL: ${url}`);
    }
    await waitForPricingPlanSelector(page);
    console.log('✅ [步骤] 已打开 ChatGPT 定价页 (#pricing)');
}

/**
 * 在定价页选择账单地区（Personal 视图下，右下角/弹窗内地区切换）
 */
async function selectPricingRegion(page, regionCode) {
    const code = String(regionCode || 'PH').toUpperCase();
    const regionConfig = getRegionConfig(code);
    console.log(`🌏 [步骤] 正在选择账单地区: ${regionConfig?.label || code}...`);

    if (await pageShowsTargetRegionPricing(page, code)) {
        console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})，跳过地区切换`);
        return;
    }

    const surfacePreview = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[Info] 当前定价页片段: ${surfacePreview}`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 定价页已显示目标地区价格 (${code})`);
            return;
        }

        if (attempt > 1) {
            console.log(`[Warn] 地区切换重试 ${attempt}/3...`);
            await closeRegionMenuIfOpen(page);
            await scrollPricingSurface(page);
        }

        let menuOpen = await isRegionMenuOpen(page);
        if (!menuOpen) {
            menuOpen = await openRegionPicker(page);
        }

        if (menuOpen || await isRegionMenuOpen(page)) {
            const selected = await selectRegionOption(page, code);
            if (!selected) {
                console.warn(`[Warn] 地区菜单已打开，但未找到 ${code} 对应选项（将尝试滚动列表）`);
            } else {
                await page.waitForTimeout(2500);
            }
        } else {
            console.warn('[Warn] 未能打开地区选择器，尝试直接滚动/点击目标地区');
            await selectRegionOption(page, code);
            await page.waitForTimeout(1500);
        }

        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);

        if (await pageShowsTargetRegionPricing(page, code)) {
            console.log(`✅ [步骤] 已切换到目标地区: ${regionConfig?.label || code}`);
            return;
        }
    }

    const finalText = (await readPricingSurfaceText(page)).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`无法将定价页切换到目标地区 ${code}（${regionConfig?.label || code}），请检查后台支付地区设置。当前页面: ${finalText}`);
}

/**
 * 点击对应套餐的升级按钮
 */
async function clickPlanUpgrade(page, planType) {
    const plan = String(planType).trim().toLowerCase();
    console.log(`📦 [步骤] 正在点击升级按钮 (套餐: ${plan})...`);

    await assertChatGptLoggedIn(page, '升级前');
    await switchToPersonalPlans(page);
    await page.waitForTimeout(1000);

    const target = await getUniqueVisiblePlanButton(page, plan);
    const button = target.button;
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 10000 });
    console.log(`✅ [步骤] 已点击套餐按钮: ${target.testId}`);
}

async function waitForCheckoutPage(page, timeout = 90000) {
    console.log('💳 [步骤] 等待跳转到 Checkout 配置套餐页...');
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        const url = page.url();
        if (url.includes('/checkout/') || url.includes('chatgpt.com/checkout')) {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);
            await assertChatGptLoggedIn(page, 'Checkout');
            console.log(`✅ [步骤] Checkout 页面已打开: ${url.slice(0, 80)}...`);
            return url;
        }
        if (url.includes('accounts.google.com')) {
            throw new Error('Session 未生效：升级后跳转到 Google 登录页');
        }
        await page.waitForTimeout(1000);
    }

    throw new Error(`等待 Checkout 页面超时，当前 URL: ${page.url()}`);
}

async function openPricingCheckout(page, { region, planType }) {
    await waitForPricingPage(page);
    await waitForPricingPlanSelector(page, planType);
    await switchToPersonalPlans(page);
    await selectPricingRegion(page, region);
    await selectProVariantOnPricingPage(page, planType);
    await clickPlanUpgrade(page, planType);
    const checkoutUrl = await waitForCheckoutPage(page);
    await selectProVariantOnCheckoutPage(page, planType);
    return checkoutUrl;
}

module.exports = {
    PRICING_URL,
    PLAN_UPGRADE_TEST_IDS,
    PRO_VARIANTS,
    resolvePlanUpgradeTestId,
    getUniqueVisiblePlanButton,
    isPricingPlanSelectorVisible,
    waitForPricingPlanSelector,
    selectProVariantOnPricingPage,
    selectProVariantOnCheckoutPage,
    openPricingCheckout,
    waitForPricingPage,
    selectPricingRegion,
    switchToPersonalPlans,
    clickPlanUpgrade,
    waitForCheckoutPage,
    pageShowsTargetRegionPricing
};
