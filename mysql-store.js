const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const {
    substituteProxySession,
    hashProxyUrl,
    parseProxyMeta,
    normalizeProxyLines,
    maskProxyUrl
} = require('./proxy-pool');
const { normalizeCaptchaPlatformApiUrl, DEFAULT_API_URL: CAPTCHA_PLATFORM_DEFAULT_URL, resolveCaptchaPlatformCredentials } = require('./captcha-platform');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_NAME = process.env.DB_NAME || 'gpt';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const SCHEMA_PATH = path.join(__dirname, 'mysql-schema.sql');
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@vru.cc').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'admin123');
const DEFAULT_ADMIN_SECONDARY_PASSWORD = String(process.env.ADMIN_SECONDARY_PASSWORD || 'admin123');
const DEFAULT_ADMIN_LOGIN_PATH = String(process.env.ADMIN_LOGIN_PATH || 'admin-login').trim().toLowerCase();
const DEFAULT_ADMIN_PANEL_PATH = String(process.env.ADMIN_PANEL_PATH || 'admin').trim().toLowerCase();
const { normalizeAdminPaths } = require('./admin-paths');

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            database: DB_NAME,
            charset: 'utf8mb4',
            waitForConnections: true,
            // 10 并发任务 × 每任务最多 3 个子流程同时操作 DB + 后台/前台请求，保守预留 60
            connectionLimit: Number(process.env.DB_POOL_LIMIT || 60),
            queueLimit: 0,
            namedPlaceholders: false,
            multipleStatements: true,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        });
    }

    return pool;
}

// 资产占用最长保留时间（ms），超过这个时长仍未释放视为崩溃，自动回收
const ASSET_LOCK_STALE_MS = Number(process.env.ASSET_LOCK_STALE_MS || 15 * 60 * 1000);

// CDK 套餐类型 → OpenAI plan_name 映射（custom checkout API）
const PLAN_NAME_MAP = {
    plus: 'chatgptplusplan',
    pro_5x: 'chatgptprolite',
    pro_20x: 'chatgptpro'
};

const VALID_PLAN_TYPES = new Set(Object.keys(PLAN_NAME_MAP));

/**
 * 将 plan_type 解析为 OpenAI plan_name
 * @param {string} planType - 'plus' | 'pro_5x' | 'pro_20x'
 * @returns {string} 对应的 plan_name，未知值默认返回 'chatgptplusplan'
 */
function resolvePlanName(planType) {
    return PLAN_NAME_MAP[planType] || PLAN_NAME_MAP.plus;
}

function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

async function runQuery(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [rows] = await executor.query(sql, params);
        return rows;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function runExecute(sql, params = [], options = {}) {
    const executor = options.connection || getPool();

    try {
        const [result] = await executor.execute(sql, params);
        return result;
    } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        throw new Error(`MySQL 执行失败: ${detail}`);
    }
}

async function withTransaction(callback) {
    const connection = await getPool().getConnection();
    try {
        await connection.beginTransaction();
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

function normalizePhonePool(phonePool) {
    return (phonePool || [])
        .filter((item) => item && item.phone)
        .map((item, index) => [
            String(item.phone),
            String(item.key || ''),
            index,
            item.is_active === 0 || item.status === 'invalid' ? 0 : 1
        ]);
}

function normalizeCardPool(cardPool) {
    return (cardPool || [])
        .filter((item) => item && item.number)
        .map((item, index) => [
            String(item.number),
            String(item.expiry || ''),
            String(item.cvc || ''),
            index,
            item.is_active === 0 || item.status === 'invalid' ? 0 : 1
        ]);
}

function normalizeCdks(cdks) {
    return [...new Set((cdks || []).filter(Boolean).map((item) => String(item).trim()))];
}

async function initializeBaseData() {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = app_config.config_value;`,
        [
            'proxy', '',
            'admin_password_hash', createPasswordHash(DEFAULT_ADMIN_PASSWORD),
            'admin_password_version', '1',
            'admin_email', DEFAULT_ADMIN_EMAIL,
            'admin_secondary_password_hash', createPasswordHash(DEFAULT_ADMIN_SECONDARY_PASSWORD),
            'admin_secondary_password_version', '1',
            'admin_totp_secret', '',
            'admin_totp_enabled', '0',
            'telegram_on_admin_login', '1',
            'admin_2fa_login_mode', 'either',
            'admin_login_path', DEFAULT_ADMIN_LOGIN_PATH,
            'admin_panel_path', DEFAULT_ADMIN_PANEL_PATH,
            'max_concurrent_activations', '1',
            'max_background_concurrent', '1',
            'maintenance_mode', '0',
            'maintenance_mode_drain', '0',
            'pool_email_enabled', '0',
            'pool_email_imap_host', 'outlook.office365.com',
            'pool_email_include_junk', '1',
            'random_email_domain', 'chiyiyi.cloud',
            'email_source', 'random',
            'inbox_api_base', 'https://temp-email-api.jzqkwl.com',
            'inbox_email_domain', '',
            'inbox_email_domains', '',
            'payment_region', 'PH',
            'external_card_api_key', crypto.randomUUID(),
            'last_used_address_id', '',
            'telegram_bot_token', '',
            'telegram_admin_chat_id', '',
            'telegram_group_chat_id', '',
            'telegram_notify_admin', '0',
            'telegram_notify_group', '0',
            'telegram_on_success', '0',
            'telegram_on_failure', '0',
            'telegram_on_card_pool_empty', '0',
            'hcaptcha_solver_enabled', '1',
            'hcaptcha_vlm_api_key', '',
            'hcaptcha_vlm_base_url', 'https://api.openai.com/v1',
            'hcaptcha_vlm_model', 'gpt-5.5',
            'hcaptcha_vlm_timeout', '45',
            'hcaptcha_solver_timeout', '240',
            'hcaptcha_solver_no_vlm', '0',
            'hcaptcha_cdp_port', '9222'
        ]
    );
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = app_config.config_value`,
        [
            'card_max_subscription_count', '2',
            'card_max_decline_count', '3'
        ]
    );
}

async function ensureAdminSecurityDefaults() {
    const defaults = [
        ['admin_email', DEFAULT_ADMIN_EMAIL],
        ['admin_secondary_password_hash', createPasswordHash(DEFAULT_ADMIN_SECONDARY_PASSWORD)],
        ['admin_secondary_password_version', '1'],
        ['admin_totp_secret', ''],
        ['admin_totp_enabled', '0'],
        ['telegram_on_admin_login', '1'],
        ['admin_2fa_login_mode', 'either'],
        ['admin_login_path', DEFAULT_ADMIN_LOGIN_PATH],
        ['admin_panel_path', DEFAULT_ADMIN_PANEL_PATH]
    ];
    for (const [key, value] of defaults) {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE config_value = config_value`,
            [key, value]
        );
    }
}

async function ensureHcaptchaConfigDefaults() {
    const defaults = [
        ['hcaptcha_solver_enabled', '1'],
        ['hcaptcha_vlm_api_key', ''],
        ['hcaptcha_vlm_base_url', 'https://api.openai.com/v1'],
        ['hcaptcha_vlm_model', 'gpt-5.5'],
        ['hcaptcha_vlm_timeout', '45'],
        ['hcaptcha_solver_timeout', '240'],
        ['hcaptcha_solver_no_vlm', '0'],
        ['hcaptcha_cdp_port', '9222']
    ];
    for (const [key, value] of defaults) {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE config_value = config_value`,
            [key, value]
        );
    }
}

// ─── 第三方 GPT 代充 API 配置 ────────────────────────────────────────────────

const GPT_API_CONFIG_KEYS = [
    'gpt_api_enabled',
    'gpt_api_base_url',
    'gpt_api_key',
    'gpt_api_plan_key',
    'gpt_api_country',
    'gpt_api_currency'
];

async function ensureGptApiColumns() {
    await ensureColumn('task_logs', 'gpt_api_order_id', "VARCHAR(128) NULL DEFAULT NULL");
    await ensureColumn('task_logs', 'gpt_api_task_id', "VARCHAR(128) NULL DEFAULT NULL");
    await ensureColumn('task_logs', 'gpt_api_raw', "MEDIUMTEXT NULL");
}

async function ensureGptApiConfigDefaults() {
    const defaults = [
        ['gpt_api_enabled', '0'],
        ['gpt_api_base_url', 'https://kc.vpss.eu.cc/'],
        ['gpt_api_key', ''],
        ['gpt_api_plan_key', 'plus'],
        ['gpt_api_country', 'PH'],
        ['gpt_api_currency', 'PHP']
    ];
    for (const [key, value] of defaults) {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE config_value = config_value`,
            [key, value]
        );
    }
}

async function getGptApiConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${GPT_API_CONFIG_KEYS.map(() => '?').join(', ')})`,
        GPT_API_CONFIG_KEYS
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(map.gpt_api_enabled || '0') === '1',
        base_url: String(map.gpt_api_base_url || 'https://kc.vpss.eu.cc/').trim()
            || 'https://kc.vpss.eu.cc/',
        api_key: String(map.gpt_api_key || '').trim(),
        plan_key: String(map.gpt_api_plan_key || 'plus').trim() || 'plus',
        country: String(map.gpt_api_country || 'PH').trim().toUpperCase() || 'PH',
        currency: String(map.gpt_api_currency || 'PHP').trim().toUpperCase() || 'PHP'
    };
}

async function saveGptApiConfig(config = {}) {
    const existing = await getGptApiConfig();
    const apiKey = String(config.api_key || '').trim() || existing.api_key || '';
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'gpt_api_enabled', config.enabled ? '1' : '0',
            'gpt_api_base_url', String(config.base_url || existing.base_url || 'https://kc.vpss.eu.cc/').trim()
                .replace(/\/+$/, '') || 'https://kc.vpss.eu.cc/',
            'gpt_api_key', apiKey,
            'gpt_api_plan_key', String(config.plan_key || existing.plan_key || 'plus').trim() || 'plus',
            'gpt_api_country', String(config.country || existing.country || 'PH').trim().toUpperCase() || 'PH',
            'gpt_api_currency', String(config.currency || existing.currency || 'PHP').trim().toUpperCase() || 'PHP'
        ]
    );
}

async function hasColumn(tableName, columnName) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [DB_NAME, tableName, columnName]
    );

    return Number(rows[0]?.count || 0) > 0;
}

async function ensureColumn(tableName, columnName, columnDefinition) {
    if (await hasColumn(tableName, columnName)) {
        return;
    }

    await runQuery(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDefinition}`);
}

async function ensureLegacyColumns() {
    await ensureColumn('app_config', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('app_config', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('phone_assets', 'sms_api_key', "VARCHAR(255) NOT NULL DEFAULT ''");
    await ensureColumn('phone_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('phone_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('phone_assets', 'in_use', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('phone_assets', 'locked_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('phone_assets', 'locked_by', 'VARCHAR(64) NULL DEFAULT NULL');
    await ensureColumn('phone_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('phone_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('card_assets', 'card_expiry', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'card_cvc', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'card_holder', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('card_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'decline_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('card_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('card_assets', 'in_use', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'locked_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'locked_by', 'VARCHAR(64) NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'last_used_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'daily_usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('card_assets', 'daily_usage_reset_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'cooldown_until', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('card_assets', 'payment_holder_name', "VARCHAR(128) NOT NULL DEFAULT '' COMMENT '支付时填写的持卡人姓名'");
    await ensureColumn('card_assets', 'payment_address_line1', "VARCHAR(200) NOT NULL DEFAULT '' COMMENT '支付绑定地址-街道'");
    await ensureColumn('card_assets', 'payment_address_city', "VARCHAR(100) NOT NULL DEFAULT '' COMMENT '支付绑定地址-城市'");
    await ensureColumn('card_assets', 'payment_address_state', "VARCHAR(100) NOT NULL DEFAULT '' COMMENT '支付绑定地址-州'");
    await ensureColumn('card_assets', 'payment_address_postal', "VARCHAR(20) NOT NULL DEFAULT '' COMMENT '支付绑定地址-邮编'");
    await ensureColumn('card_assets', 'payment_address_id', 'BIGINT UNSIGNED NULL DEFAULT NULL COMMENT \'关联免税地址模板ID\'');
    await ensureColumn('card_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('card_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('cdk_codes', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('cdk_codes', 'shipped_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'used_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('cdk_codes', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    await ensureColumn('cdk_codes', 'type', "VARCHAR(16) NOT NULL DEFAULT '自助'");
    await ensureColumn('cdk_codes', 'plan_type', "VARCHAR(16) NOT NULL DEFAULT 'plus'");

    await ensureColumn('task_logs', 'token_preview', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'phone', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'cdk_code', 'VARCHAR(32) NULL');
    await ensureColumn('task_logs', 'card_last4', 'VARCHAR(4) NULL');
    await ensureColumn('task_logs', 'status', "VARCHAR(32) NOT NULL DEFAULT 'running'");
    await ensureColumn('task_logs', 'message', 'VARCHAR(255) NULL');
    await ensureColumn('task_logs', 'progress', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('task_logs', 'display_time', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('task_logs', 'raw_output', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'failure_screenshots', 'TEXT NULL');
    await ensureColumn('task_logs', 'session_payload', 'MEDIUMTEXT NULL');
    await ensureColumn('task_logs', 'gpt_api_topup_code', "VARCHAR(255) NULL DEFAULT NULL");
    await ensureColumn('task_logs', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('task_logs', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('product_assets', 'password', 'VARCHAR(255) NULL');
    await ensureColumn('pool_emails', 'client_id', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('pool_emails', 'refresh_token', 'TEXT NULL');

    await ensureColumn('product_assets', 'imap_key', 'VARCHAR(64) NULL');
    await ensureColumn('product_assets', 'claimed_cdk', 'VARCHAR(32) NULL');
    await ensureColumn('product_assets', 'token', 'TEXT NULL');
    await ensureColumn('product_assets', 'file_path', 'VARCHAR(512) NULL');
    await ensureColumn('product_assets', 'status', "VARCHAR(32) NOT NULL DEFAULT '正常'");
    await ensureColumn('product_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('product_assets', 'shipped', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn('product_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('product_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    await ensureColumn('billing_records', 'card_number', 'VARCHAR(32) NULL');
    await ensureColumn('tax_free_addresses', 'is_bound', 'TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'是否已绑定成功支付\'');
    await ensureColumn('tax_free_addresses', 'bound_card_id', 'BIGINT UNSIGNED NULL DEFAULT NULL COMMENT \'绑定的卡片ID\'');
    await ensureColumn('tax_free_addresses', 'bound_at', 'TIMESTAMP NULL DEFAULT NULL COMMENT \'绑定时间\'');

    await ensureColumn('proxy_assets', 'proxy_url', 'TEXT NOT NULL');
    await ensureColumn('proxy_assets', 'proxy_url_hash', "CHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'label', "VARCHAR(128) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'protocol', "VARCHAR(16) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'host', "VARCHAR(255) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
    await ensureColumn('proxy_assets', 'last_check_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_ok', 'TINYINT(1) NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_ip', "VARCHAR(64) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'last_check_latency_ms', 'INT NULL DEFAULT NULL');
    await ensureColumn('proxy_assets', 'last_check_error', "VARCHAR(512) NOT NULL DEFAULT ''");
    await ensureColumn('proxy_assets', 'usage_count', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('proxy_assets', 'sort_order', 'INT NOT NULL DEFAULT 0');
    await ensureColumn('proxy_assets', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('proxy_assets', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
}

async function seedTaxFreeAddresses() {
    // Only seed if the table is empty (avoid duplicate seeding)
    const countRows = await runQuery(`SELECT COUNT(*) AS count FROM tax_free_addresses`);
    if (Number(countRows[0]?.count || 0) > 0) {
        return;
    }

    const seeds = [
        // ─── PH (Philippines) — tax-free economic zones ───────────────────────
        ['PH', '32nd Street corner 9th Avenue', 'Taguig', 'Metro Manila', '1634', 'PH'],
        ['PH', 'One Bonifacio High Street', 'Taguig', 'Metro Manila', '1635', 'PH'],
        ['PH', '6787 Ayala Avenue', 'Makati', 'Metro Manila', '1226', 'PH'],
        ['PH', 'Mactan Economic Zone II', 'Lapu-Lapu', 'Cebu', '6015', 'PH'],
        ['PH', 'Cebu IT Park, Lahug', 'Cebu City', 'Cebu', '6000', 'PH'],
        ['PH', 'Clark Freeport Zone, Bldg 2145', 'Angeles', 'Pampanga', '2009', 'PH'],

        // ─── US — states without sales tax ────────────────────────────────────
        ['US', '1234 NW Flanders Street', 'Portland', 'OR', '97209', 'US'],
        ['US', '567 Main Street', 'Bozeman', 'MT', '59715', 'US'],
        ['US', '890 Market Street', 'Wilmington', 'DE', '19801', 'US'],
        ['US', '45 Elm Street', 'Concord', 'NH', '03301', 'US'],

        // ─── SG (Singapore) — no state-level sales tax on digital services ───
        ['SG', '1 Raffles Place #20-01', 'Singapore', 'Singapore', '048616', 'SG'],
        ['SG', '80 Robinson Road #02-00', 'Singapore', 'Singapore', '068898', 'SG'],
        ['SG', '1 Harbourfront Walk #01-153', 'Singapore', 'Singapore', '098585', 'SG'],

        // ─── MY (Malaysia) — Labuan / duty-free zones ─────────────────────────
        ['MY', 'Level 15, Main Office Tower', 'Labuan', 'Labuan FT', '87000', 'MY'],
        ['MY', 'Lot 3A-1, Level 3A, Labuan Times Square', 'Labuan', 'Labuan FT', '87000', 'MY'],
        ['MY', 'Ground Floor, Wisma Oceanic', 'Labuan', 'Labuan FT', '87007', 'MY']
    ];

    const placeholders = seeds.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const flatValues = seeds.flat();

    await runQuery(
        `INSERT IGNORE INTO tax_free_addresses (region, line1, city, state, postal_code, country)
         VALUES ${placeholders}`,
        flatValues
    );
}

async function cleanupStaleLegacyTasks() {
    const result = await runExecute(
        `UPDATE task_logs
         SET status = 'failed',
             message = '遗留成品任务已自动清理',
             progress = 100,
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'running'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'`
    );
    if (result?.affectedRows > 0) {
        console.log(`🧹 [任务] 已清理 ${result.affectedRows} 条遗留成品 running 任务`);
    }
}

async function ensureReady() {
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await runQuery(schemaSql);
    await ensureLegacyColumns();
    await ensureGptApiColumns();
    await initializeBaseData();
    await ensureAdminSecurityDefaults();
    await ensureHcaptchaConfigDefaults();
    await ensureGptApiConfigDefaults();
    await syncHcaptchaConfigPersistence();
    await migrateLegacyProxyConfig();
    await seedTaxFreeAddresses();
    await cleanupStaleLegacyTasks();
}

function parseAdminProductGenerationTask(row) {
    const cdkCode = String(row?.cdk_code || '');
    let payload = null;

    try {
        payload = row?.raw_output ? JSON.parse(row.raw_output) : null;
    } catch (_) { }

    let targetCount = 0;
    let completedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let workerCount = 0;
    let aborted = false;
    let lastError = '';

    if (payload && payload.kind === 'admin_product_generation') {
        targetCount = Math.max(0, Number(payload.targetCount) || 0);
        completedCount = Math.max(0, Number(payload.completedCount) || 0);
        successCount = Math.max(0, Number(payload.successCount) || 0);
        failedCount = Math.max(0, Number(payload.failedCount) || 0);
        workerCount = Math.max(0, Number(payload.workerCount) || 0);
        aborted = Boolean(payload.aborted);
        lastError = String(payload.lastError || '').trim();
    }

    if (!targetCount) {
        const match = cdkCode.match(/^ADMIN_PRODUCT_GEN:(\d+)$/);
        targetCount = match ? Math.max(0, Number(match[1]) || 0) : 0;
    }

    completedCount = Math.min(targetCount, completedCount);
    const remainingCount = Math.max(0, targetCount - completedCount);

    return {
        jobKey: String(row?.job_key || ''),
        cdkCode,
        status: String(row?.status || ''),
        targetCount,
        completedCount,
        remainingCount,
        successCount,
        failedCount,
        workerCount,
        aborted,
        lastError
    };
}

function isResumableProductGenerationTask(task) {
    if (!task || task.remainingCount <= 0 || !task.aborted) {
        return false;
    }

    const message = String(task.lastError || '');
    return message.includes('系统维护中')
        || message.includes('余额不足')
        || message.includes('代理')
        || message.includes('无法获取有效的 Access Token')
        || message.includes('页面仍无法正常显示');
}

async function getResumableAdminProductGeneration() {
    const runningRows = await runQuery(
        `SELECT job_key, cdk_code, raw_output, status
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'
         ORDER BY created_at DESC, id DESC`
    );

    if (runningRows.length > 0) {
        return null;
    }

    const failedRows = await runQuery(
        `SELECT job_key, cdk_code, raw_output, status
         FROM task_logs
         WHERE status = 'failed'
           AND cdk_code LIKE 'ADMIN_PRODUCT_GEN:%'
         ORDER BY created_at DESC, id DESC
         LIMIT 20`
    );

    for (const row of failedRows) {
        const task = parseAdminProductGenerationTask(row);
        if (isResumableProductGenerationTask(task)) {
            return task;
        }
    }

    return null;
}

function parseAutomationSummary(rawOutput) {
    const text = String(rawOutput || '');
    const stages = [
        {
            key: 'order',
            label: '订单',
            done: /订单创建成功/.test(text),
            failed: /订单创建失败|无法获取支付链接/.test(text)
        },
        {
            key: 'checkout',
            label: 'Checkout',
            done: /Checkout 页面已打开/.test(text),
            failed: false
        },
        {
            key: 'payment',
            label: '支付流程',
            done: /信用卡卡池支付流程|正在使用 Stripe/.test(text),
            failed: false
        },
        {
            key: 'card',
            label: '预留卡片',
            done: /已预留卡片/.test(text),
            failed: false
        },
        {
            key: 'stripe_form',
            label: 'Stripe表单',
            done: /卡号已填写/.test(text),
            failed: /card_number_not_found|无法定位信用卡号|无法定位有效期|无法定位 CVC/.test(text)
        },
        {
            key: 'paid',
            label: '支付成功',
            done: /PAYMENT_SUCCESS|最终校验：支付成功/.test(text),
            failed: false
        }
    ];

    let phase = '等待启动';
    if (/PAYMENT_SUCCESS|最终校验：支付成功/.test(text)) {
        phase = '支付成功';
    } else if (/manual_intervention|需要人工操作|已连续失败 3 次/.test(text)) {
        phase = '需人工介入';
    } else if (/card_number_not_found|无法定位信用卡号/.test(text)) {
        phase = 'Stripe 表单定位失败';
    } else if (/Checkout 页面已打开/.test(text)) {
        phase = 'Checkout 已打开';
    } else if (/订单创建成功/.test(text)) {
        phase = '订单已创建';
    } else if (/创建订单/.test(text)) {
        phase = '创建订单中';
    } else if (/正在检查代理/.test(text)) {
        phase = '检查代理中';
    }

    return {
        phase,
        checkoutOpened: /Checkout 页面已打开/.test(text),
        paymentStarted: /信用卡卡池支付流程|PaymentRetry/.test(text),
        stages
    };
}

function normalizeMediaPath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const marker = 'debug_screenshots/';
    const idx = normalized.indexOf(marker);
    if (idx >= 0) {
        return normalized.slice(idx + marker.length);
    }
    return path.basename(normalized);
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

function extractTaskMediaFromOutput(output) {
    const screenshots = new Set();
    const videos = new Set();
    const text = String(output || '');
    const shotPatterns = [
        /FAILURE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /SUCCESS_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /LIVE_SCREENSHOT:\s*([^\s\n]+\.png)/g,
        /截图已保存:\s*([^\s\n]+\.png)/g
    ];
    for (const pattern of shotPatterns) {
        let match = pattern.exec(text);
        while (match) {
            screenshots.add(normalizeMediaPath(match[1]));
            match = pattern.exec(text);
        }
    }
    const videoPattern = /VIDEO_FILE:\s*([^\s\n]+\.webm)/g;
    let vmatch = videoPattern.exec(text);
    while (vmatch) {
        videos.add(normalizeMediaPath(vmatch[1]));
        vmatch = videoPattern.exec(text);
    }
    return { screenshots: [...screenshots], videos: [...videos] };
}

function deleteTaskMediaFiles(row = {}) {
    const fromStored = splitTaskMediaPaths(
        (() => {
            if (!row.failure_screenshots) return [];
            try {
                const parsed = JSON.parse(row.failure_screenshots);
                return Array.isArray(parsed) ? parsed : [];
            } catch (_) {
                return [];
            }
        })()
    );
    const fromOutput = extractTaskMediaFromOutput(row.raw_output || '');
    const relPaths = [...new Set([
        ...fromStored.screenshots,
        ...fromStored.videos,
        ...fromOutput.screenshots,
        ...fromOutput.videos
    ])];

    const root = path.join(__dirname, 'debug_screenshots');
    let deleted = 0;
    for (const rel of relPaths) {
        const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalized || normalized.includes('..')) continue;
        const fullPath = path.join(root, normalized);
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) continue;
        try {
            fs.unlinkSync(fullPath);
            deleted += 1;
        } catch (_) { /* ignore */ }
    }
    return { deleted, paths: relPaths };
}

function formatAdminTaskLogRow(row) {
    let storedMedia = [];
    if (row.failure_screenshots) {
        try {
            const parsed = JSON.parse(row.failure_screenshots);
            storedMedia = Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            storedMedia = [];
        }
    }

    const fromStored = splitTaskMediaPaths(storedMedia);
    const fromOutput = extractTaskMediaFromOutput(row.raw_output || '');
    const screenshots = [...new Set([...fromStored.screenshots, ...fromOutput.screenshots])];
    const videos = [...new Set([...fromStored.videos, ...fromOutput.videos])];

    const automation = parseAutomationSummary(row.raw_output || '');
    const message = String(row.message || '').trim()
        || (automation.phase !== '等待启动' ? automation.phase : '');

    return {
        id: row.job_key,
        jobKey: row.job_key,
        time: row.display_time,
        token: row.token_preview,
        cdk: row.cdk_code || '',
        phone: row.phone,
        message,
        cardLast4: row.card_last4 || '',
        status: row.status,
        progress: Number(row.progress || 0),
        screenshots,
        videos,
        automation
    };
}

async function listAdminTaskLogs(limit = 200) {
    const rows = await runQuery(
        `SELECT l.job_key, l.display_time, l.token_preview, l.cdk_code, l.phone, l.card_last4,
                l.status, l.message, l.progress, l.failure_screenshots, l.raw_output, c.type AS cdk_type
         FROM task_logs l
         LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
         WHERE (l.cdk_code IS NULL OR l.cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%')
           AND (c.type IS NULL OR c.type = '' OR c.type = '自助')
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
        [Math.min(500, Math.max(1, Number(limit) || 200))]
    );
    return rows.map(formatAdminTaskLogRow);
}

async function getBillingOverviewStats() {
    const rows = await runQuery(
        `SELECT
            currency,
            COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(status = 'success'), 0) AS paid_count
         FROM billing_records
         GROUP BY currency
         ORDER BY paid_count DESC`
    );
    return rows.map((row) => ({
        currency: String(row.currency || 'USD'),
        revenue: Number(row.revenue || 0),
        paid_count: Number(row.paid_count || 0)
    }));
}

const CARD_POLICY_MIN = 1;
const CARD_POLICY_MAX = 100;

const normalizeCardPolicyValue = (value, label) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < CARD_POLICY_MIN || parsed > CARD_POLICY_MAX) {
        throw new Error(`${label}必须是 ${CARD_POLICY_MIN}-${CARD_POLICY_MAX} 的整数`);
    }
    return parsed;
};

const getCardPolicy = async () => {
    const [maxSubscriptionCount, maxDeclineCount] = await Promise.all([
        getAppConfigValue('card_max_subscription_count'),
        getAppConfigValue('card_max_decline_count')
    ]);
    return {
        maxSubscriptionCount: normalizeCardPolicyValue(maxSubscriptionCount, '单卡最多绑定订阅数'),
        maxDeclineCount: normalizeCardPolicyValue(maxDeclineCount, '单卡最多明确拒付次数')
    };
};

async function getAdminData() {
    const [configRows, phoneRows, cardRows, logRows, statsRows, cdkStatsRows, billingOverviewRows] = await Promise.all([
        runQuery(
            `SELECT config_key, config_value
             FROM app_config
             WHERE config_key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'proxy',
                'max_concurrent_activations',
                'max_background_concurrent',
                'maintenance_mode',
                'maintenance_mode_drain',
                'pool_email_enabled',
                'pool_email_imap_host',
                'pool_email_include_junk',
                'random_email_domain',
                'email_source',
                'inbox_api_base',
                'inbox_email_domain',
                'inbox_email_domains',
                'card_max_subscription_count',
                'card_max_decline_count'
            ]
        ),
        runQuery(
            `SELECT phone, sms_api_key, usage_count, is_active, status
             FROM phone_assets
             ORDER BY sort_order ASC, id ASC`
        ),
        runQuery(
            `SELECT card_number, card_expiry, card_cvc, usage_count, decline_count, is_active, status
             FROM card_assets
             ORDER BY sort_order ASC, id ASC`
        ),
        listAdminTaskLogs(200),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(status = 'success'), 0) AS success,
                COALESCE(SUM(status IN ('failed', 'card_invalid', 'manual', 'retry', 'maintenance')), 0) AS failed,
                COALESCE(SUM(status = 'running'), 0) AS running
             FROM task_logs
             WHERE cdk_code IS NULL OR cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%'`
        ),
        runQuery(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(used_at IS NOT NULL), 0) AS used_count,
                COALESCE(SUM(used_at IS NULL), 0) AS unused_count
             FROM cdk_codes
             WHERE is_active = 1`
        ),
        getBillingOverviewStats()
    ]);

    const stats = statsRows[0] || {};
    const cdkStats = cdkStatsRows[0] || {};
    const billingOverview = Array.isArray(billingOverviewRows) ? billingOverviewRows : [];
    const primaryBilling = billingOverview[0] || { currency: 'USD', revenue: 0, paid_count: 0 };
    const configMap = Object.fromEntries(configRows.map((row) => [row.config_key, row.config_value]));
    const telegram = await getTelegramConfig();
    const hcaptcha = await getHcaptchaConfig();
    return {
        config: {
            max_concurrent_activations: Math.max(1, Number(configMap.max_concurrent_activations || 1)),
            max_background_concurrent: Math.max(1, Number(configMap.max_background_concurrent || 1)),
            card_max_subscription_count: normalizeCardPolicyValue(
                configMap.card_max_subscription_count,
                '单卡最多绑定订阅数'
            ),
            card_max_decline_count: normalizeCardPolicyValue(
                configMap.card_max_decline_count,
                '单卡最多明确拒付次数'
            ),
            maintenance_mode: String(configMap.maintenance_mode || '0') === '1',
            maintenance_mode_drain: String(configMap.maintenance_mode_drain || '0') === '1',
            email_source: ['random', 'pool', 'inbox'].includes(String(configMap.email_source || ''))
                ? String(configMap.email_source)
                : (String(configMap.pool_email_enabled || '0') === '1' ? 'pool' : 'random'),
            pool_email_enabled: String(configMap.pool_email_enabled || '0') === '1',
            pool_email_imap_host: String(configMap.pool_email_imap_host || 'outlook.office365.com').trim() || 'outlook.office365.com',
            pool_email_include_junk: String(configMap.pool_email_include_junk || '1') === '1',
            random_email_domain: String(configMap.random_email_domain || 'chiyiyi.cloud').trim().replace(/^@/, '') || 'chiyiyi.cloud',
            inbox_api_base: String(configMap.inbox_api_base || 'https://temp-email-api.jzqkwl.com').trim().replace(/\/+$/, '') || 'https://temp-email-api.jzqkwl.com',
            inbox_email_domain: String(configMap.inbox_email_domain || '').trim().replace(/^@/, ''),
            inbox_email_domains: String(configMap.inbox_email_domains || '').split(/[\n,;\s]+/).map((d) => d.trim().replace(/^@/, '')).filter(Boolean),
            phone_pool: phoneRows.map((row) => ({
                phone: row.phone,
                key: row.sms_api_key,
                usage_count: Number(row.usage_count || 0),
                is_active: Number(row.is_active || 0),
                status: Number(row.is_active || 0) === 1
                    ? 'normal'
                    : String(row.status || 'invalid').trim() || 'invalid'
            })),
            card_pool: cardRows.map((row) => ({
                number: row.card_number,
                expiry: row.card_expiry,
                cvc: row.card_cvc,
                usage_count: Number(row.usage_count || 0),
                decline_count: Number(row.decline_count || 0),
                is_active: Number(row.is_active || 0),
                status: Number(row.is_active || 0) === 1
                    ? 'normal'
                    : String(row.status || 'invalid').trim() || 'invalid'
            }))
        },
        stats: {
            total: Number(stats.total || 0),
            success: Number(stats.success || 0),
            failed: Number(stats.failed || 0),
            running: Number(stats.running || 0),
            cdk_total: Number(cdkStats.total || 0),
            cdk_used: Number(cdkStats.used_count || 0),
            cdk_unused: Number(cdkStats.unused_count || 0),
            billing_revenue: Number(primaryBilling.revenue || 0),
            billing_currency: primaryBilling.currency || 'USD',
            billing_paid_count: Number(primaryBilling.paid_count || 0),
            billing_by_currency: billingOverview
        },
        telegram,
        hcaptcha: publicHcaptchaConfig(hcaptcha),
        logs: logRows
    };
}

async function saveConfig(config = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(config, key);
    const configEntries = [];

    if (hasOwn('max_concurrent_activations')) {
        configEntries.push([
            'max_concurrent_activations',
            String(Math.max(1, Number(config.max_concurrent_activations || 1)))
        ]);
    }
    if (hasOwn('max_background_concurrent')) {
        configEntries.push([
            'max_background_concurrent',
            String(Math.max(1, Number(config.max_background_concurrent || 1)))
        ]);
    }
    let cardMaxSubscriptionCount = null;
    if (hasOwn('card_max_subscription_count')) {
        cardMaxSubscriptionCount = normalizeCardPolicyValue(
            config.card_max_subscription_count,
            '单卡最多绑定订阅数'
        );
        configEntries.push(['card_max_subscription_count', String(cardMaxSubscriptionCount)]);
    }
    if (hasOwn('card_max_decline_count')) {
        const cardMaxDeclineCount = normalizeCardPolicyValue(
            config.card_max_decline_count,
            '单卡最多明确拒付次数'
        );
        configEntries.push(['card_max_decline_count', String(cardMaxDeclineCount)]);
    }
    if (hasOwn('maintenance_mode')) {
        configEntries.push(['maintenance_mode', config.maintenance_mode ? '1' : '0']);
    }
    if (hasOwn('maintenance_mode_drain')) {
        configEntries.push(['maintenance_mode_drain', config.maintenance_mode_drain ? '1' : '0']);
    }
    if (hasOwn('email_source') || hasOwn('pool_email_enabled')) {
        const emailSource = ['random', 'pool', 'inbox'].includes(String(config.email_source))
            ? String(config.email_source)
            : (config.pool_email_enabled ? 'pool' : 'random');
        configEntries.push(['email_source', emailSource]);
        configEntries.push(['pool_email_enabled', emailSource === 'pool' ? '1' : '0']);
    }
    if (hasOwn('pool_email_imap_host')) {
        configEntries.push([
            'pool_email_imap_host',
            String(config.pool_email_imap_host || 'outlook.office365.com').trim() || 'outlook.office365.com'
        ]);
    }
    if (hasOwn('pool_email_include_junk')) {
        const poolEmailIncludeJunk = config.pool_email_include_junk === false
            || String(config.pool_email_include_junk || '1') === '0'
            ? '0'
            : '1';
        configEntries.push(['pool_email_include_junk', poolEmailIncludeJunk]);
    }
    if (hasOwn('random_email_domain')) {
        configEntries.push([
            'random_email_domain',
            String(config.random_email_domain || 'chiyiyi.cloud').trim().replace(/^@/, '').toLowerCase() || 'chiyiyi.cloud'
        ]);
    }
    if (hasOwn('inbox_api_base')) {
        configEntries.push([
            'inbox_api_base',
            String(config.inbox_api_base || 'https://temp-email-api.jzqkwl.com').trim().replace(/\/+$/, '')
                || 'https://temp-email-api.jzqkwl.com'
        ]);
    }
    if (hasOwn('inbox_email_domain')) {
        configEntries.push([
            'inbox_email_domain',
            String(config.inbox_email_domain || '').trim().replace(/^@/, '').toLowerCase()
        ]);
    }
    if (hasOwn('inbox_email_domains')) {
        const inboxEmailDomainsList = (() => {
            const raw = config.inbox_email_domains;
            if (Array.isArray(raw)) {
                return raw.map((d) => String(d || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
            }
            return String(raw || '')
                .split(/[\n,;\s]+/)
                .map((d) => d.trim().replace(/^@/, '').toLowerCase())
                .filter(Boolean);
        })();
        configEntries.push(['inbox_email_domains', inboxEmailDomainsList.join('\n')]);
    }

    const phonePool = hasOwn('phone_pool')
        ? normalizePhonePool(Array.isArray(config.phone_pool) ? config.phone_pool : [])
        : null;
    const cardPool = hasOwn('card_pool')
        ? normalizeCardPool(Array.isArray(config.card_pool) ? config.card_pool : [])
        : null;

    await withTransaction(async (connection) => {
        if (configEntries.length > 0) {
            const placeholders = configEntries.map(() => '(?, ?)').join(', ');
            const params = configEntries.flat();
            await runExecute(
                `INSERT INTO app_config (config_key, config_value)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
                params,
                { connection }
            );
        }

        if (cardMaxSubscriptionCount !== null) {
            await reconcileCardSubscriptionLimit(cardMaxSubscriptionCount, connection);
        }

        if (phonePool !== null) {
            if (phonePool.length > 0) {
                const phones = phonePool.map((item) => item[0]);
                const phonePlaceholders = phones.map(() => '?').join(', ');
                await runExecute(
                    `DELETE FROM phone_assets
                     WHERE phone NOT IN (${phonePlaceholders})`,
                    phones,
                    { connection }
                );
                await connection.query(
                    `INSERT INTO phone_assets (phone, sms_api_key, sort_order, is_active) VALUES ?
                     ON DUPLICATE KEY UPDATE
                        sms_api_key = VALUES(sms_api_key),
                        sort_order = VALUES(sort_order),
                        is_active = VALUES(is_active)`,
                    [phonePool]
                );
            } else {
                await runExecute(`DELETE FROM phone_assets`, [], { connection });
            }
        }

        if (cardPool !== null) {
            if (cardPool.length > 0) {
                const cardNumbers = cardPool.map((item) => item[0]);
                const cardPlaceholders = cardNumbers.map(() => '?').join(', ');
                await runExecute(
                    `DELETE FROM card_assets
                     WHERE card_number NOT IN (${cardPlaceholders})`,
                    cardNumbers,
                    { connection }
                );
                for (const card of cardPool) {
                    const result = await runExecute(
                        `UPDATE card_assets
                         SET card_expiry = ?,
                             card_cvc = ?,
                             sort_order = ?,
                             is_active = ?
                         WHERE card_number = ?`,
                        [card[1], card[2], card[3], card[4], card[0]],
                        { connection }
                    );
                    if (result.affectedRows === 0) {
                        await runExecute(
                            `INSERT INTO card_assets (card_number, card_expiry, card_cvc, sort_order, is_active)
                             VALUES (?, ?, ?, ?, ?)`,
                            card,
                            { connection }
                        );
                    }
                }
            } else {
                await runExecute(`DELETE FROM card_assets`, [], { connection });
            }
        }
    });
}

async function listCdks() {
    const rows = await runQuery(
        `SELECT c.cdk_code, c.shipped_at, c.used_at, c.type, c.plan_type, c.created_at,
                (
                    SELECT l.token_preview
                    FROM task_logs l
                    WHERE l.cdk_code = c.cdk_code
                      AND l.token_preview IS NOT NULL
                      AND l.token_preview != ''
                    ORDER BY l.created_at DESC, l.id DESC
                    LIMIT 1
                ) AS session_preview,
                (
                    SELECT l.job_key
                    FROM task_logs l
                    WHERE l.cdk_code = c.cdk_code
                      AND l.token_preview IS NOT NULL
                      AND l.token_preview != ''
                    ORDER BY l.created_at DESC, l.id DESC
                    LIMIT 1
                ) AS session_job_key
         FROM cdk_codes c
         WHERE c.is_active = 1
           AND (c.type = '自助' OR c.type IS NULL OR c.type = '')
         ORDER BY c.created_at DESC, c.id DESC`
    );

    const runningRows = await runQuery(
        `SELECT cdk_code, MAX(updated_at) AS updated_at
         FROM task_logs
         WHERE status = 'running'
           AND cdk_code IS NOT NULL
         GROUP BY cdk_code`
    );
    const runningSet = new Set(runningRows.map((row) => String(row.cdk_code || '').trim()).filter(Boolean));

    return rows.map((row) => ({
        code: row.cdk_code,
        status: runningSet.has(String(row.cdk_code || '').trim())
            ? 'processing'
            : (row.used_at ? 'used' : 'unused'),
        type: row.type || '自助',
        plan_type: row.plan_type || 'plus',
        shipped: Boolean(row.shipped_at),
        shipped_at: row.shipped_at
            ? new Date(row.shipped_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        used_at: row.used_at
            ? new Date(row.used_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        session_preview: row.session_preview || null,
        session_job_key: row.session_job_key || null
    }));
}

async function listSessions(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 200, 500));
    const rows = await runQuery(
        `SELECT l.job_key, l.display_time, l.token_preview, l.session_payload, l.cdk_code, l.phone, l.card_last4,
                l.status, l.message, l.progress, l.created_at, l.updated_at
         FROM task_logs l
         LEFT JOIN cdk_codes c ON l.cdk_code = c.cdk_code
         WHERE l.token_preview IS NOT NULL
           AND l.token_preview != ''
           AND (l.cdk_code IS NULL OR l.cdk_code NOT LIKE 'ADMIN_PRODUCT_GEN:%')
           AND (c.type IS NULL OR c.type = '' OR c.type = '自助')
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
        [limit]
    );

    return rows.map((row) => ({
        job_key: row.job_key,
        time: row.display_time,
        token_preview: row.token_preview,
        has_session: Boolean(row.session_payload),
        cdk_code: row.cdk_code || '',
        card_last4: row.card_last4 || '',
        status: row.status,
        message: row.message || '',
        progress: Number(row.progress || 0),
        created_at: row.created_at
            ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null,
        updated_at: row.updated_at
            ? new Date(row.updated_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : null
    }));
}

async function getSessionByJobKey(jobKey) {
    const rows = await runQuery(
        `SELECT job_key, display_time, token_preview, session_payload, cdk_code, card_last4, status, message, progress, created_at, updated_at
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey)]
    );
    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        job_key: row.job_key,
        time: row.display_time,
        token_preview: row.token_preview,
        session_payload: row.session_payload || '',
        cdk_code: row.cdk_code || '',
        card_last4: row.card_last4 || '',
        status: row.status,
        message: row.message || '',
        progress: Number(row.progress || 0),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

async function markCdkShipped(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET shipped_at = COALESCE(shipped_at, CURRENT_TIMESTAMP)
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}
async function insertCdks(cdks, options = {}) {
    const normalized = normalizeCdks(cdks);
    if (normalized.length === 0) {
        return {
            insertedCount: 0,
            duplicateCount: 0,
            totalCount: 0
        };
    }

    const type = options.type || '自助';
    const planType = VALID_PLAN_TYPES.has(options.plan_type) ? options.plan_type : 'plus';
    const values = normalized.map((cdk) => [cdk, 1, type, planType]);
    console.log(`正在插入 ${values.length} 个 CDK, 类型: ${type}, 套餐: ${planType}`);

    const [result] = await getPool().query(
        `INSERT INTO cdk_codes (cdk_code, is_active, type, plan_type) VALUES ?`,
        [values]
    );

    const insertedCount = Number(result?.affectedRows || 0);
    console.log(`插入完成, 影响行数: ${insertedCount}`);

    return {
        insertedCount,
        duplicateCount: Math.max(0, normalized.length - insertedCount),
        totalCount: normalized.length
    };
}

async function deleteCdk(cdk) {
    await runExecute(`DELETE FROM cdk_codes WHERE cdk_code = ?`, [String(cdk)]);
}

async function verifyCdk(cdk) {
    const rows = await runQuery(
        `SELECT COUNT(*) AS count
         FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );

    return Number(rows[0]?.count || 0) > 0;
}

async function verifyCdkDetails(cdk) {
    const rows = await runQuery(
        `SELECT * FROM cdk_codes
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function recordCdkFailure(cdk) {
    // 增加失败次数
    await runExecute(
        `UPDATE cdk_codes 
         SET fail_count = fail_count + 1 
         WHERE cdk_code = ?`,
        [String(cdk)]
    );

    // 检查是否达到 3 次
    const cdkDetails = await verifyCdkDetails(cdk);
    if (cdkDetails && cdkDetails.fail_count >= 3) {
        // 达到 3 次，设置 10 分钟冷却，并重置失败次数
        await runExecute(
            `UPDATE cdk_codes 
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE cdk_code = ?`,
            [String(cdk)]
        );
        return true; // 触发了冷却
    }
    return false;
}

async function resetCdkFailure(cdk) {
    await runExecute(
        `UPDATE cdk_codes 
         SET fail_count = 0, cooldown_until = NULL 
         WHERE cdk_code = ?`,
        [String(cdk)]
    );
}

async function getActivationAttemptLimit(scopeType, scopeKey) {
    const rows = await runQuery(
        `SELECT scope_type, scope_key, fail_count, cooldown_until
         FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?
         LIMIT 1`,
        [String(scopeType), String(scopeKey)]
    );
    return rows[0] || null;
}

async function recordActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `INSERT INTO activation_attempt_limits (scope_type, scope_key, fail_count, cooldown_until)
         VALUES (?, ?, 1, NULL)
         ON DUPLICATE KEY UPDATE fail_count = fail_count + 1`,
        [String(scopeType), String(scopeKey)]
    );

    const limit = await getActivationAttemptLimit(scopeType, scopeKey);
    if (limit && Number(limit.fail_count || 0) >= 3) {
        await runExecute(
            `UPDATE activation_attempt_limits
             SET cooldown_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE),
                 fail_count = 0
             WHERE scope_type = ?
               AND scope_key = ?`,
            [String(scopeType), String(scopeKey)]
        );
        return true;
    }
    return false;
}

async function resetActivationAttemptFailure(scopeType, scopeKey) {
    await runExecute(
        `DELETE FROM activation_attempt_limits
         WHERE scope_type = ?
           AND scope_key = ?`,
        [String(scopeType), String(scopeKey)]
    );
}

async function markCdkUsed(cdk) {
    const result = await runExecute(
        `UPDATE cdk_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE cdk_code = ?
           AND is_active = 1
           AND used_at IS NULL`,
        [String(cdk)]
    );
    return result.affectedRows > 0;
}

async function markCdkUnused(cdk) {
    await runExecute(
        `UPDATE cdk_codes
         SET used_at = NULL
         WHERE cdk_code = ?
           AND is_active = 1`,
        [String(cdk)]
    );
}

async function deletePhoneAsset(phone) {
    if (!phone) {
        return;
    }

    await runExecute(
        `UPDATE phone_assets
         SET is_active = 0,
             status = '已报废'
         WHERE phone = ?`,
        [String(phone)]
    );
}

async function deleteCardAsset(cardNumber) {
    if (!cardNumber) {
        return;
    }

    await runExecute(
        `UPDATE card_assets
         SET is_active = 0,
             status = '已报废'
         WHERE card_number = ?`,
        [String(cardNumber)]
    );
}

// 在事务里挑一个未占用资产并立即标记 in_use；无可用资产时返回 null 而不是阻塞。
// 用 FOR UPDATE SKIP LOCKED 避免两个并发任务同时抢同一行。
async function reserveAssetRow(connection, table, columns, ownerKey) {
    const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
    const colList = ['id', ...columns].join(', ');
    const [rows] = await connection.query(
        `SELECT ${colList}
         FROM ${table}
         WHERE is_active = 1
           AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)
         ORDER BY usage_count ASC, COALESCE(locked_at, '1970-01-01') ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [staleThreshold]
    );

    if (!rows.length) {
        return null;
    }

    const row = rows[0];
    await connection.query(
        `UPDATE ${table}
         SET in_use = 1,
             locked_at = CURRENT_TIMESTAMP,
             locked_by = ?
         WHERE id = ?`,
        [String(ownerKey || '').slice(0, 64) || null, row.id]
    );

    return row;
}

async function reserveRuntimeAssets(ownerKey = '') {
    return withTransaction(async (connection) => {
        const [cardRow] = await Promise.all([
            reserveAssetRow(connection, 'card_assets', ['card_number', 'card_expiry', 'card_cvc', 'card_holder', 'usage_count'], ownerKey)
        ]);

        const proxyRows = await connection.query(
            `SELECT proxy_url FROM proxy_assets WHERE is_active = 1 ORDER BY RAND() LIMIT 1`
        ).then((r) => r[0]);
        const pickedProxy = proxyRows[0]?.proxy_url
            ? substituteProxySession(String(proxyRows[0].proxy_url))
            : '';

        return {
            phoneAssetId: null,
            cardAssetId: cardRow?.id || null,
            phone: { phone: '', key: '', usage_count: 0 },
            card: cardRow
                ? {
                    number: cardRow.card_number,
                    expiry: cardRow.card_expiry,
                    cvc: cardRow.card_cvc,
                    holder: cardRow.card_holder || '',
                    usage_count: Number(cardRow.usage_count || 0)
                }
                : { number: '', expiry: '', cvc: '', holder: '', usage_count: 0 },
            proxy: pickedProxy
        };
    });
}

async function releaseAssetById(table, id) {
    if (!id) {
        return;
    }
    await runExecute(
        `UPDATE ${table}
         SET in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE id = ?`,
        [Number(id)]
    );
}

async function releaseRuntimeAssets({ phoneAssetId, cardAssetId } = {}) {
    const tasks = [];
    if (phoneAssetId) tasks.push(releaseAssetById('phone_assets', phoneAssetId));
    if (cardAssetId) tasks.push(releaseAssetById('card_assets', cardAssetId));
    if (tasks.length) {
        await Promise.all(tasks);
    }
}

// 兜底：把超过 ASSET_LOCK_STALE_MS 仍未释放的锁强制清理（任务进程崩溃后回收用）
async function releaseStaleAssetLocks() {
    const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
    const [phoneResult, cardResult, poolResult] = await Promise.all([
        runExecute(
            `UPDATE phone_assets
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        ),
        runExecute(
            `UPDATE card_assets
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE in_use = 1 AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        ),
        runExecute(
            `UPDATE pool_emails
             SET in_use = 0, locked_at = NULL, locked_by = NULL
             WHERE registered = 0
               AND in_use = 1
               AND (locked_at IS NULL OR locked_at < ?)`,
            [staleThreshold]
        )
    ]);

    return {
        phoneReleased: Number(phoneResult?.affectedRows || 0),
        cardReleased: Number(cardResult?.affectedRows || 0),
        poolReleased: Number(poolResult?.affectedRows || 0)
    };
}

// 启动时先把所有 in_use 标记彻底重置（崩溃重启场景）
async function resetAllAssetLocks() {
    await Promise.all([
        runExecute(`UPDATE phone_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1`),
        runExecute(`UPDATE card_assets SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE in_use = 1`),
        runExecute(`UPDATE pool_emails SET in_use = 0, locked_at = NULL, locked_by = NULL WHERE registered = 0 AND in_use = 1`)
    ]);
}

// 支持两种格式：
//   1) Outlook/MS OAuth2:  email----password----client_id----refresh_token
//   2) 简单密码:            email\tpassword   或   email password
function parseMailTxtImport(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let skipped = 0;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        let email = '';
        let password = '';
        let clientId = '';
        let refreshToken = '';

        if (line.includes('----')) {
            const segs = line.split('----').map((s) => s.trim());
            if (segs.length >= 4 && segs[0].includes('@')) {
                email = segs[0].toLowerCase();
                password = segs[1] || '';
                clientId = segs[2] || '';
                refreshToken = segs.slice(3).join('----').trim();
            } else if (segs.length >= 2 && segs[0].includes('@')) {
                email = segs[0].toLowerCase();
                password = segs.slice(1).join('----').trim();
            } else {
                skipped += 1;
                continue;
            }
        } else {
            let parts = line.split('\t').map((s) => s.trim()).filter(Boolean);
            if (parts.length < 2) {
                parts = line.split(/\s+/).filter(Boolean);
            }
            if (parts.length < 2 || !parts[0].includes('@')) {
                skipped += 1;
                continue;
            }
            email = parts[0].toLowerCase();
            password = parts.slice(1).join(' ').trim();
        }

        if (!email || (!password && !refreshToken)) {
            skipped += 1;
            continue;
        }

        out.push({ email, password, clientId, refreshToken });
    }

    return { rows: out, skipped };
}

async function bulkImportPoolEmails(text) {
    const { rows, skipped } = parseMailTxtImport(text);
    let applied = 0;
    let oauthCount = 0;

    await withTransaction(async (connection) => {
        for (let i = 0; i < rows.length; i++) {
            const { email, password, clientId, refreshToken } = rows[i];
            if (refreshToken) {
                oauthCount += 1;
            }
            await connection.execute(
                `INSERT INTO pool_emails (email, password, client_id, refresh_token, sort_order, is_active)
                 VALUES (?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                    password = VALUES(password),
                    client_id = CASE WHEN VALUES(client_id) <> '' THEN VALUES(client_id) ELSE pool_emails.client_id END,
                    refresh_token = CASE WHEN VALUES(refresh_token) IS NOT NULL AND VALUES(refresh_token) <> ''
                                         THEN VALUES(refresh_token)
                                         ELSE pool_emails.refresh_token END,
                    is_active = 1`,
                [email, password, clientId || '', refreshToken || null, i]
            );
            applied += 1;
        }
    });

    return { applied, parsed: rows.length, skipped, oauthCount };
}

async function listPoolEmails() {
    const rows = await runQuery(
        `SELECT id, email,
                CASE WHEN LENGTH(TRIM(password)) > 0 THEN 1 ELSE 0 END AS has_password,
                CASE WHEN refresh_token IS NOT NULL AND LENGTH(TRIM(refresh_token)) > 0 THEN 1 ELSE 0 END AS has_oauth,
                registered, registered_at, in_use, locked_at, is_active, created_at
         FROM pool_emails
         WHERE is_active = 1
         ORDER BY id ASC`
    );

    return rows.map((row) => ({
        id: row.id,
        email: row.email,
        has_password: Number(row.has_password || 0) === 1,
        has_oauth: Number(row.has_oauth || 0) === 1,
        registered: Number(row.registered || 0) === 1,
        registered_at: row.registered_at,
        in_use: Number(row.in_use || 0) === 1,
        locked_at: row.locked_at,
        created_at: row.created_at
    }));
}

async function getPoolEmailCredentials(id) {
    const rows = await runQuery(
        `SELECT id, email, password, client_id, refresh_token, registered, is_active
         FROM pool_emails
         WHERE id = ?
         LIMIT 1`,
        [Number(id)]
    );

    const row = rows[0];
    if (!row || Number(row.is_active || 0) !== 1) {
        return null;
    }

    return {
        id: row.id,
        email: row.email,
        password: row.password || '',
        clientId: row.client_id || '',
        refreshToken: row.refresh_token || '',
        registered: Number(row.registered || 0) === 1
    };
}

async function deletePoolEmail(id) {
    await runExecute(`DELETE FROM pool_emails WHERE id = ?`, [Number(id)]);
}

async function reservePoolEmail(ownerKey = '') {
    return withTransaction(async (connection) => {
        const staleThreshold = new Date(Date.now() - ASSET_LOCK_STALE_MS);
        const [rows] = await connection.query(
            `SELECT id, email, password, client_id, refresh_token
             FROM pool_emails
             WHERE is_active = 1
               AND registered = 0
               AND (in_use = 0 OR locked_at IS NULL OR locked_at < ?)
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [staleThreshold]
        );

        if (!rows.length) {
            return null;
        }

        const row = rows[0];
        await connection.query(
            `UPDATE pool_emails
             SET in_use = 1, locked_at = CURRENT_TIMESTAMP, locked_by = ?
             WHERE id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.id]
        );

        return {
            id: row.id,
            email: row.email,
            password: row.password || '',
            clientId: row.client_id || '',
            refreshToken: row.refresh_token || ''
        };
    });
}

async function releasePoolEmailReservation(id) {
    if (!id) {
        return;
    }

    await runExecute(
        `UPDATE pool_emails
         SET in_use = 0, locked_at = NULL, locked_by = NULL
         WHERE id = ?
           AND registered = 0`,
        [Number(id)]
    );
}

async function markPoolEmailRegistered(id) {
    if (!id) {
        return;
    }

    await runExecute(
        `UPDATE pool_emails
         SET registered = 1,
             registered_at = CURRENT_TIMESTAMP,
             in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE id = ?`,
        [Number(id)]
    );
}

// 把 {session} 占位符替换成随机字符串，便于 Kookeey/Brightdata 等住宅代理走 sticky session
// substituteProxySession 已移至 proxy-pool.js

function formatProxyAssetRow(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        proxy_url: String(row.proxy_url || ''),
        proxy_url_masked: maskProxyUrl(row.proxy_url),
        label: String(row.label || ''),
        protocol: String(row.protocol || ''),
        host: String(row.host || ''),
        is_active: Number(row.is_active) === 1,
        last_check_at: row.last_check_at || null,
        last_check_ok: row.last_check_ok === null || row.last_check_ok === undefined
            ? null
            : Number(row.last_check_ok) === 1,
        last_check_ip: String(row.last_check_ip || ''),
        last_check_latency_ms: row.last_check_latency_ms === null || row.last_check_latency_ms === undefined
            ? null
            : Number(row.last_check_latency_ms),
        last_check_error: String(row.last_check_error || ''),
        usage_count: Number(row.usage_count || 0),
        sort_order: Number(row.sort_order || 0),
        created_at: row.created_at || null,
        updated_at: row.updated_at || null
    };
}

async function listProxyAssets() {
    const rows = await runQuery(
        `SELECT *
         FROM proxy_assets
         ORDER BY sort_order ASC, id ASC`
    );
    return rows.map(formatProxyAssetRow);
}

async function addProxyAssets(input) {
    const lines = normalizeProxyLines(input);
    if (!lines.length) {
        return { success: false, error: '未提供代理 URL' };
    }

    let added = 0;
    let skipped = 0;
    const ids = [];

    for (const line of lines) {
        const urlHash = hashProxyUrl(line);
        const existing = await runQuery(
            `SELECT id FROM proxy_assets WHERE proxy_url_hash = ? LIMIT 1`,
            [urlHash]
        );
        if (existing.length) {
            skipped += 1;
            continue;
        }
        const meta = parseProxyMeta(line);
        const result = await runExecute(
            `INSERT INTO proxy_assets (proxy_url, proxy_url_hash, protocol, host, is_active, sort_order)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [line, urlHash, meta.protocol || '', meta.host || '', Date.now() % 1000000]
        );
        added += 1;
        ids.push(Number(result.insertId));
    }

    return {
        success: true,
        added,
        skipped,
        ids,
        message: `已保存 ${added} 条代理${skipped ? `，跳过重复 ${skipped} 条` : ''}`
    };
}

async function deleteProxyAsset(id) {
    const result = await runExecute(
        `DELETE FROM proxy_assets WHERE id = ?`,
        [Number(id)]
    );
    if (!result.affectedRows) {
        return { success: false, error: '代理不存在' };
    }
    return { success: true };
}

async function setProxyAssetActive(id, isActive) {
    const result = await runExecute(
        `UPDATE proxy_assets SET is_active = ? WHERE id = ?`,
        [isActive ? 1 : 0, Number(id)]
    );
    if (!result.affectedRows) {
        return { success: false, error: '代理不存在' };
    }
    return { success: true, is_active: Boolean(isActive) };
}

async function updateProxyAssetCheck(id, checkResult) {
    const ok = Boolean(checkResult?.ok);
    await runExecute(
        `UPDATE proxy_assets
         SET last_check_at = CURRENT_TIMESTAMP,
             last_check_ok = ?,
             last_check_ip = ?,
             last_check_latency_ms = ?,
             last_check_error = ?
         WHERE id = ?`,
        [
            ok ? 1 : 0,
            ok ? String(checkResult.ip || '') : '',
            ok ? Number(checkResult.latencyMs || 0) : null,
            ok ? '' : String(checkResult.error || '检测失败').slice(0, 512),
            Number(id)
        ]
    );
}

async function getProxyAssetById(id) {
    const rows = await runQuery(
        `SELECT * FROM proxy_assets WHERE id = ? LIMIT 1`,
        [Number(id)]
    );
    return formatProxyAssetRow(rows[0]);
}

async function migrateLegacyProxyConfig() {
    const rows = await runQuery(
        `SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1`,
        ['proxy']
    );
    const raw = String(rows[0]?.config_value || '').trim();
    if (!raw) {
        return;
    }

    const countRows = await runQuery(`SELECT COUNT(*) AS count FROM proxy_assets`);
    const existingCount = Number(countRows[0]?.count || 0);
    const lines = normalizeProxyLines(raw);
    if (!lines.length) {
        await runExecute(
            `UPDATE app_config SET config_value = '' WHERE config_key = ?`,
            ['proxy']
        );
        return;
    }

    if (existingCount === 0) {
        await addProxyAssets(lines);
    }

    await runExecute(
        `UPDATE app_config SET config_value = '' WHERE config_key = ?`,
        ['proxy']
    );
}

// 只取代理，不占用手机/卡资产；适合注册/协议提取这种只用代理的子流程
// 支持 {session} 占位符；每次调用替换为新的随机 sticky session ID
async function getActiveProxy() {
    const rows = await runQuery(
        `SELECT proxy_url
         FROM proxy_assets
         WHERE is_active = 1
         ORDER BY RAND()
         LIMIT 1`
    );
    if (!rows.length) {
        return '';
    }
    await runExecute(
        `UPDATE proxy_assets SET usage_count = usage_count + 1 WHERE proxy_url = ?`,
        [rows[0].proxy_url]
    ).catch(() => { });
    return substituteProxySession(String(rows[0].proxy_url || ''));
}

// 兼容旧调用：仅返回代理 + 资源快照，不再锁定（防止误用阻塞资产池）
async function getRuntimeAssets() {
    const [phoneRows, cardRows, proxy] = await Promise.all([
        runQuery(
            `SELECT phone, sms_api_key, usage_count
             FROM phone_assets
             WHERE is_active = 1
             ORDER BY usage_count ASC, id ASC
             LIMIT 1`
        ),
        runQuery(
            `SELECT card_number, card_expiry, card_cvc, usage_count
             FROM card_assets
             WHERE is_active = 1
             ORDER BY usage_count ASC, id ASC
             LIMIT 1`
        ),
        getActiveProxy()
    ]);

    const phoneRow = phoneRows[0];
    const cardRow = cardRows[0];
    return {
        phone: phoneRow
            ? { phone: phoneRow.phone, key: phoneRow.sms_api_key, usage_count: Number(phoneRow.usage_count || 0) }
            : { phone: '未配置', key: '', usage_count: 0 },
        card: cardRow
            ? { number: cardRow.card_number, expiry: cardRow.card_expiry, cvc: cardRow.card_cvc, usage_count: Number(cardRow.usage_count || 0) }
            : { number: '', expiry: '', cvc: '', usage_count: 0 },
        proxy
    };
}

async function incrementAssetSuccessCount({ phone, cardNumber }) {
    const tasks = [];

    if (phone) {
        tasks.push(
            runExecute(
                `UPDATE phone_assets
                 SET usage_count = usage_count + 1
                 WHERE phone = ? AND is_active = 1`,
                [String(phone)]
            )
        );
    }

    if (cardNumber) {
        tasks.push(
            runExecute(
                `UPDATE card_assets
                 SET usage_count = usage_count + 1
                 WHERE card_number = ? AND is_active = 1`,
                [String(cardNumber)]
            )
        );
    }

    if (tasks.length > 0) {
        await Promise.all(tasks);
    }
}

async function getAppConfigValue(configKey, fallbackValue = '') {
    const rows = await runQuery(
        `SELECT config_value
         FROM app_config
         WHERE config_key = ?
         LIMIT 1`,
        [String(configKey)]
    );
    return rows[0]?.config_value ?? fallbackValue;
}

async function setAppConfigValue(configKey, configValue) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [String(configKey), String(configValue ?? '')]
    );
}

const BROWSER_POOL_CONFIG_KEY = 'browser_pool_enabled';

function parseBooleanConfig(value, fallback = false) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
        return true;
    }
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
        return false;
    }
    return Boolean(fallback);
}

async function getBrowserPoolEnabled() {
    const fromDb = await getAppConfigValue(BROWSER_POOL_CONFIG_KEY, '');
    if (fromDb !== '') {
        return parseBooleanConfig(fromDb, false);
    }
    return parseBooleanConfig(process.env.BROWSER_POOL, true);
}

async function setBrowserPoolEnabled(enabled) {
    await setAppConfigValue(BROWSER_POOL_CONFIG_KEY, enabled ? '1' : '0');
    return Boolean(enabled);
}

async function getTelegramConfig() {
    const keys = [
        'telegram_bot_token',
        'telegram_admin_chat_id',
        'telegram_group_chat_id',
        'telegram_notify_admin',
        'telegram_notify_group',
        'telegram_on_success',
        'telegram_on_failure',
        'telegram_on_card_pool_empty'
    ];
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${keys.map(() => '?').join(', ')})`,
        keys
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        bot_token: String(map.telegram_bot_token || '').trim(),
        admin_chat_id: String(map.telegram_admin_chat_id || '').trim(),
        group_chat_id: String(map.telegram_group_chat_id || '').trim(),
        notify_admin: String(map.telegram_notify_admin || '0') === '1',
        notify_group: String(map.telegram_notify_group || '0') === '1',
        on_success: String(map.telegram_on_success || '0') === '1',
        on_failure: String(map.telegram_on_failure || '0') === '1',
        on_card_pool_empty: String(map.telegram_on_card_pool_empty || '0') === '1'
    };
}

const DEFAULT_HCAPTCHA_VLM_MODEL = 'gpt-5.5';

function resolveHcaptchaConfigFilePath() {
    return String(process.env.HCAPTCHA_CONFIG_FILE || path.join(__dirname, 'data', 'hcaptcha-config.json')).trim();
}

function readHcaptchaConfigFile(filePath = resolveHcaptchaConfigFilePath()) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!raw || typeof raw !== 'object') {
            return null;
        }
        return {
            enabled: raw.enabled !== false && String(raw.enabled ?? '1') !== '0',
            vlm_api_key: String(raw.vlm_api_key || '').trim(),
            vlm_base_url: String(raw.vlm_base_url || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
            vlm_model: String(raw.vlm_model || DEFAULT_HCAPTCHA_VLM_MODEL).trim() || DEFAULT_HCAPTCHA_VLM_MODEL,
            vlm_timeout: Math.max(10, Number(raw.vlm_timeout || 45) || 45),
            solver_timeout: Math.max(60, Number(raw.solver_timeout || 240) || 240),
            no_vlm: Boolean(raw.no_vlm),
            cdp_port: String(raw.cdp_port || '9222').trim() || '9222',
            captcha_platform_api_key: String(raw.captcha_platform_api_key || '').trim(),
            captcha_platform_api_url: String(raw.captcha_platform_api_url || 'https://api.capsolver.com').trim()
                .replace(/\/+$/, '') || 'https://api.capsolver.com',
            captcha_platform_timeout: Math.max(30, Number(raw.captcha_platform_timeout || 180) || 180)
        };
    } catch (error) {
        console.warn(`[hCaptcha] 读取配置文件失败: ${error.message}`);
        return null;
    }
}

function writeHcaptchaConfigFile(config, filePath = resolveHcaptchaConfigFilePath()) {
    try {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const payload = {
            enabled: config.enabled !== false,
            vlm_api_key: String(config.vlm_api_key || '').trim(),
            vlm_base_url: String(config.vlm_base_url || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
            vlm_model: String(config.vlm_model || DEFAULT_HCAPTCHA_VLM_MODEL).trim() || DEFAULT_HCAPTCHA_VLM_MODEL,
            vlm_timeout: Math.max(10, Number(config.vlm_timeout || 45) || 45),
            solver_timeout: Math.max(60, Number(config.solver_timeout || 240) || 240),
            no_vlm: Boolean(config.no_vlm),
            cdp_port: String(config.cdp_port || '9222').trim() || '9222',
            captcha_platform_api_key: String(config.captcha_platform_api_key || '').trim(),
            captcha_platform_api_url: String(config.captcha_platform_api_url || 'https://api.capsolver.com').trim()
                .replace(/\/+$/, '') || 'https://api.capsolver.com',
            captcha_platform_timeout: Math.max(30, Number(config.captcha_platform_timeout || 180) || 180),
            updated_at: new Date().toISOString()
        };
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        return true;
    } catch (error) {
        console.warn(`[hCaptcha] 写入配置文件失败: ${error.message}`);
        return false;
    }
}

function readHcaptchaConfigFromEnv() {
    const patch = {};
    const envKey = String(process.env.HCAPTCHA_VLM_API_KEY || process.env.CTF_VLM_API_KEY || '').trim();
    const envBase = String(process.env.HCAPTCHA_VLM_BASE_URL || process.env.CTF_VLM_BASE_URL || '').trim();
    const envModel = String(process.env.HCAPTCHA_VLM_MODEL || process.env.CTF_VLM_MODEL || '').trim();
    if (envKey) patch.vlm_api_key = envKey;
    if (envBase) patch.vlm_base_url = envBase;
    if (envModel) patch.vlm_model = envModel;
    if (process.env.HCAPTCHA_SOLVER_ENABLED !== undefined) {
        patch.enabled = String(process.env.HCAPTCHA_SOLVER_ENABLED) !== '0';
    }
    if (process.env.HCAPTCHA_SOLVER_NO_VLM !== undefined) {
        patch.no_vlm = String(process.env.HCAPTCHA_SOLVER_NO_VLM) === '1';
    }
    if (process.env.HCAPTCHA_VLM_TIMEOUT) {
        patch.vlm_timeout = Math.max(10, Number(process.env.HCAPTCHA_VLM_TIMEOUT) || 45);
    }
    if (process.env.HCAPTCHA_SOLVER_TIMEOUT) {
        patch.solver_timeout = Math.max(60, Number(process.env.HCAPTCHA_SOLVER_TIMEOUT) || 240);
    }
    if (process.env.HCAPTCHA_CDP_PORT || process.env.CDP_PORT) {
        patch.cdp_port = String(process.env.HCAPTCHA_CDP_PORT || process.env.CDP_PORT || '9222').trim() || '9222';
    }
    const platformKey = String(
        process.env.HCAPTCHA_CAPTCHA_PLATFORM_API_KEY
        || process.env.CAPTCHA_PLATFORM_API_KEY
        || process.env.CTF_CAPTCHA_API_KEY
        || ''
    ).trim();
    const platformUrl = String(
        process.env.HCAPTCHA_CAPTCHA_PLATFORM_API_URL
        || process.env.CAPTCHA_PLATFORM_API_URL
        || process.env.CTF_CAPTCHA_API_URL
        || ''
    ).trim();
    if (platformKey) {
        patch.captcha_platform_api_key = platformKey;
    }
    if (platformUrl) {
        patch.captcha_platform_api_url = platformUrl.replace(/\/+$/, '');
    }
    if (process.env.HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT || process.env.CAPTCHA_PLATFORM_TIMEOUT) {
        patch.captcha_platform_timeout = Math.max(
            30,
            Number(process.env.HCAPTCHA_CAPTCHA_PLATFORM_TIMEOUT || process.env.CAPTCHA_PLATFORM_TIMEOUT) || 180
        );
    }
    return patch;
}

function mergeHcaptchaConfigLayers(dbCfg, fileCfg, envCfg) {
    const merged = { ...dbCfg };
    if (fileCfg) {
        if (!merged.vlm_api_key && fileCfg.vlm_api_key) merged.vlm_api_key = fileCfg.vlm_api_key;
        if (fileCfg.vlm_base_url) merged.vlm_base_url = fileCfg.vlm_base_url;
        if (fileCfg.vlm_model) merged.vlm_model = fileCfg.vlm_model;
        if (fileCfg.vlm_timeout) merged.vlm_timeout = fileCfg.vlm_timeout;
        if (fileCfg.solver_timeout) merged.solver_timeout = fileCfg.solver_timeout;
        if (fileCfg.cdp_port) merged.cdp_port = fileCfg.cdp_port;
        if (fileCfg.no_vlm !== undefined) merged.no_vlm = fileCfg.no_vlm;
        if (fileCfg.enabled !== undefined) merged.enabled = fileCfg.enabled;
        if (!merged.captcha_platform_api_key && fileCfg.captcha_platform_api_key) {
            merged.captcha_platform_api_key = fileCfg.captcha_platform_api_key;
        }
        if (fileCfg.captcha_platform_api_url) merged.captcha_platform_api_url = fileCfg.captcha_platform_api_url;
        if (fileCfg.captcha_platform_timeout) merged.captcha_platform_timeout = fileCfg.captcha_platform_timeout;
    }
    for (const [key, value] of Object.entries(envCfg || {})) {
        if (value !== undefined && value !== null && value !== '') {
            merged[key] = value;
        }
    }
    return merged;
}

function hcaptchaConfigNeedsDbUpdate(before, after) {
    const fields = [
        'vlm_api_key', 'vlm_base_url', 'vlm_model', 'vlm_timeout', 'solver_timeout',
        'no_vlm', 'enabled', 'cdp_port',
        'captcha_platform_api_key', 'captcha_platform_api_url', 'captcha_platform_timeout'
    ];
    return fields.some((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
}

async function syncHcaptchaConfigPersistence() {
    const fileCfg = readHcaptchaConfigFile();
    const envCfg = readHcaptchaConfigFromEnv();
    const dbCfg = await getHcaptchaConfig();
    const merged = mergeHcaptchaConfigLayers(dbCfg, fileCfg, envCfg);

    if (hcaptchaConfigNeedsDbUpdate(dbCfg, merged)) {
        await saveHcaptchaConfig(merged, { skipFileWrite: true });
        console.log('[hCaptcha] 已从 .env / data/hcaptcha-config.json 同步 VLM 配置到数据库');
    }

    const latest = await getHcaptchaConfig();
    if (latest.vlm_api_key || latest.captcha_platform_api_key) {
        writeHcaptchaConfigFile(latest);
    }
}

function publicHcaptchaConfig(config = {}) {
    const key = String(config.vlm_api_key || '').trim();
    const platformKey = String(config.captcha_platform_api_key || '').trim();
    return {
        enabled: config.enabled !== false,
        vlm_api_key: '',
        vlm_api_key_saved: Boolean(key),
        vlm_api_key_preview: key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '',
        vlm_base_url: config.vlm_base_url,
        vlm_model: config.vlm_model,
        vlm_timeout: config.vlm_timeout,
        solver_timeout: config.solver_timeout,
        no_vlm: Boolean(config.no_vlm),
        cdp_port: config.cdp_port,
        captcha_platform_api_key: '',
        captcha_platform_api_key_saved: Boolean(platformKey),
        captcha_platform_api_key_preview: platformKey ? `${platformKey.slice(0, 8)}…${platformKey.slice(-4)}` : '',
        captcha_platform_api_url: config.captcha_platform_api_url,
        captcha_platform_timeout: config.captcha_platform_timeout
    };
}

async function getHcaptchaConfig() {
    const keys = [
        'hcaptcha_solver_enabled',
        'hcaptcha_vlm_api_key',
        'hcaptcha_vlm_base_url',
        'hcaptcha_vlm_model',
        'hcaptcha_vlm_timeout',
        'hcaptcha_solver_timeout',
        'hcaptcha_solver_no_vlm',
        'hcaptcha_cdp_port',
        'hcaptcha_captcha_platform_api_key',
        'hcaptcha_captcha_platform_api_url',
        'hcaptcha_captcha_platform_timeout'
    ];
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (${keys.map(() => '?').join(', ')})`,
        keys
    );
    const map = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(map.hcaptcha_solver_enabled ?? '1') !== '0',
        vlm_api_key: String(map.hcaptcha_vlm_api_key || '').trim(),
        vlm_base_url: String(map.hcaptcha_vlm_base_url || 'https://api.openai.com/v1').trim()
            || 'https://api.openai.com/v1',
        vlm_model: String(map.hcaptcha_vlm_model || 'gpt-5.5').trim() || 'gpt-5.5',
        vlm_timeout: Math.max(10, Number(map.hcaptcha_vlm_timeout || 45) || 45),
        solver_timeout: Math.max(60, Number(map.hcaptcha_solver_timeout || 240) || 240),
        no_vlm: String(map.hcaptcha_solver_no_vlm || '0') === '1',
        cdp_port: String(map.hcaptcha_cdp_port || '9222').trim() || '9222',
        captcha_platform_api_key: String(map.hcaptcha_captcha_platform_api_key || '').trim(),
        captcha_platform_api_url: String(map.hcaptcha_captcha_platform_api_url || 'https://api.capsolver.com').trim()
            .replace(/\/+$/, '') || 'https://api.capsolver.com',
        captcha_platform_timeout: Math.max(30, Number(map.hcaptcha_captcha_platform_timeout || 180) || 180)
    };
}

async function saveHcaptchaConfig(config = {}, options = {}) {
    const existing = await getHcaptchaConfig();
    const enabled = config.enabled === false || String(config.enabled) === '0' ? '0' : '1';
    const noVlm = config.no_vlm ? '1' : '0';
    const vlmTimeout = String(Math.max(10, Number(config.vlm_timeout || existing.vlm_timeout || 45) || 45));
    const solverTimeout = String(Math.max(60, Number(config.solver_timeout || existing.solver_timeout || 240) || 240));
    const cdpPort = String(config.cdp_port || existing.cdp_port || '9222').trim() || '9222';
    const vlmApiKey = String(config.vlm_api_key || '').trim() || existing.vlm_api_key || '';
    const platformApiKey = String(config.captcha_platform_api_key || '').trim() || existing.captcha_platform_api_key || '';
    const platformResolved = resolveCaptchaPlatformCredentials(
        platformApiKey,
        config.captcha_platform_api_url || existing.captcha_platform_api_url || CAPTCHA_PLATFORM_DEFAULT_URL
    );
    const platformApiUrl = platformResolved.apiUrl;
    const platformTimeout = String(Math.max(
        30,
        Number(config.captcha_platform_timeout || existing.captcha_platform_timeout || 180) || 180
    ));

    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'hcaptcha_solver_enabled', enabled,
            'hcaptcha_vlm_api_key', vlmApiKey,
            'hcaptcha_vlm_base_url', String(config.vlm_base_url || existing.vlm_base_url || 'https://api.openai.com/v1').trim()
                || 'https://api.openai.com/v1',
            'hcaptcha_vlm_model', String(config.vlm_model || existing.vlm_model || DEFAULT_HCAPTCHA_VLM_MODEL).trim() || DEFAULT_HCAPTCHA_VLM_MODEL,
            'hcaptcha_vlm_timeout', vlmTimeout,
            'hcaptcha_solver_timeout', solverTimeout,
            'hcaptcha_solver_no_vlm', noVlm,
            'hcaptcha_cdp_port', cdpPort,
            'hcaptcha_captcha_platform_api_key', platformApiKey,
            'hcaptcha_captcha_platform_api_url', platformApiUrl,
            'hcaptcha_captcha_platform_timeout', platformTimeout
        ]
    );

    if (!options.skipFileWrite && (vlmApiKey || platformApiKey)) {
        writeHcaptchaConfigFile({
            enabled: enabled !== '0',
            vlm_api_key: vlmApiKey,
            vlm_base_url: String(config.vlm_base_url || existing.vlm_base_url || 'https://api.openai.com/v1').trim()
                || 'https://api.openai.com/v1',
            vlm_model: String(config.vlm_model || existing.vlm_model || DEFAULT_HCAPTCHA_VLM_MODEL).trim() || DEFAULT_HCAPTCHA_VLM_MODEL,
            vlm_timeout: Number(vlmTimeout),
            solver_timeout: Number(solverTimeout),
            no_vlm: noVlm === '1',
            cdp_port: cdpPort,
            captcha_platform_api_key: platformApiKey,
            captcha_platform_api_url: platformApiUrl,
            captcha_platform_timeout: Number(platformTimeout)
        });
    }
}

async function saveTelegramConfig(config = {}) {
    const existing = await getTelegramConfig();
    const notifyAdmin = config.notify_admin ? '1' : '0';
    const notifyGroup = config.notify_group ? '1' : '0';
    const onSuccess = config.on_success ? '1' : '0';
    const onFailure = config.on_failure ? '1' : '0';
    const onCardPoolEmpty = config.on_card_pool_empty ? '1' : '0';
    const botToken = String(config.bot_token || '').trim() || existing.bot_token || '';

    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'telegram_bot_token', botToken,
            'telegram_admin_chat_id', String(config.admin_chat_id || '').trim(),
            'telegram_group_chat_id', String(config.group_chat_id || '').trim(),
            'telegram_notify_admin', notifyAdmin,
            'telegram_notify_group', notifyGroup,
            'telegram_on_success', onSuccess,
            'telegram_on_failure', onFailure,
            'telegram_on_card_pool_empty', onCardPoolEmpty
        ]
    );
}

async function getMaxConcurrentActivations() {
    const config = await getAdminData();
    return config.config.max_concurrent_activations;
}

async function getMaxBackgroundConcurrent() {
    const config = await getAdminData();
    return config.config.max_background_concurrent;
}

async function getMaintenanceModeState() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['maintenance_mode', 'maintenance_mode_drain']
    );
    const configMap = Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
    return {
        enabled: String(configMap.maintenance_mode || '0') === '1',
        drain: String(configMap.maintenance_mode_drain || '0') === '1'
    };
}

async function setMaintenanceModeState(enabled, drain = false) {
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?), (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [
            'maintenance_mode', enabled ? '1' : '0',
            'maintenance_mode_drain', drain ? '1' : '0'
        ]
    );
}

async function getAdminAuthConfig() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'admin_password_hash',
            'admin_password_version',
            'admin_email',
            'admin_secondary_password_hash',
            'admin_secondary_password_version',
            'admin_totp_secret',
            'admin_totp_enabled',
            'telegram_on_admin_login',
            'admin_2fa_login_mode'
        ]
    );

    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));

    return {
        email: String(map.admin_email || DEFAULT_ADMIN_EMAIL).trim().toLowerCase(),
        passwordHash: String(map.admin_password_hash || ''),
        passwordVersion: Math.max(1, Number(map.admin_password_version || 1)),
        secondaryPasswordHash: String(map.admin_secondary_password_hash || ''),
        secondaryPasswordVersion: Math.max(1, Number(map.admin_secondary_password_version || 1)),
        totpSecret: String(map.admin_totp_secret || ''),
        totpEnabled: String(map.admin_totp_enabled || '0') === '1',
        notifyAdminLogin: String(map.telegram_on_admin_login || '1') !== '0',
        login2faMode: ['either', 'totp', 'telegram'].includes(String(map.admin_2fa_login_mode || '').trim().toLowerCase())
            ? String(map.admin_2fa_login_mode || 'either').trim().toLowerCase()
            : 'either'
    };
}

async function saveAdmin2faLoginMode(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!['either', 'totp', 'telegram'].includes(normalized)) {
        throw new Error('无效的登录验证方式');
    }
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        ['admin_2fa_login_mode', normalized]
    );
    return normalized;
}

async function getAdminPaths() {
    const rows = await runQuery(
        `SELECT config_key, config_value
         FROM app_config
         WHERE config_key IN (?, ?)`,
        ['admin_login_path', 'admin_panel_path']
    );
    const map = Object.fromEntries(rows.map((item) => [item.config_key, item.config_value]));
    return normalizeAdminPaths({
        loginPath: map.admin_login_path || DEFAULT_ADMIN_LOGIN_PATH,
        panelPath: map.admin_panel_path || DEFAULT_ADMIN_PANEL_PATH
    });
}

async function saveAdminPaths({ loginPath, panelPath }) {
    const normalized = normalizeAdminPaths({ loginPath, panelPath });
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_login_path', normalized.loginPath,
                'admin_panel_path', normalized.panelPath
            ],
            { connection }
        );
    });
    return normalized;
}

async function updateAdminEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
        throw new Error('管理员邮箱格式无效');
    }
    await runExecute(
        `INSERT INTO app_config (config_key, config_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        ['admin_email', normalized]
    );
    return normalized;
}

async function updateAdminSecondaryPassword(password) {
    const nextHash = createPasswordHash(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.secondaryPasswordVersion || 1)) + 1;
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_secondary_password_hash', nextHash,
                'admin_secondary_password_version', String(nextVersion)
            ],
            { connection }
        );
    });
    return { secondaryPasswordVersion: nextVersion };
}

async function saveAdminTotpConfig({ secret, enabled }) {
    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_totp_secret', String(secret || ''),
                'admin_totp_enabled', enabled ? '1' : '0'
            ],
            { connection }
        );
    });
}

async function insertAdminLoginLog({
    event,
    adminEmail = '',
    ip = '',
    userAgent = '',
    fingerprint = '',
    detail = ''
}) {
    await runExecute(
        `INSERT INTO admin_login_logs (event, admin_email, ip, user_agent, fingerprint, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            String(event || 'unknown').slice(0, 32),
            String(adminEmail || '').slice(0, 128) || null,
            String(ip || '').slice(0, 45) || null,
            String(userAgent || '').slice(0, 512) || null,
            String(fingerprint || '').slice(0, 128) || null,
            String(detail || '').slice(0, 512) || null
        ]
    );
}

async function listAdminLoginLogs(limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = await runQuery(
        `SELECT id, event, admin_email, ip, user_agent, fingerprint, detail, created_at
         FROM admin_login_logs
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [safeLimit, safeOffset]
    );
    const countRows = await runQuery(`SELECT COUNT(*) AS total FROM admin_login_logs`);
    return {
        logs: rows,
        total: Number(countRows[0]?.total || 0),
        limit: safeLimit,
        offset: safeOffset
    };
}

async function updateAdminPassword(password) {
    const nextHash = createPasswordHash(password);
    const authConfig = await getAdminAuthConfig();
    const nextVersion = Math.max(1, Number(authConfig.passwordVersion || 1)) + 1;

    await withTransaction(async (connection) => {
        await runExecute(
            `INSERT INTO app_config (config_key, config_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
            [
                'admin_password_hash', nextHash,
                'admin_password_version', String(nextVersion)
            ],
            { connection }
        );
    });

    return {
        passwordHash: nextHash,
        passwordVersion: nextVersion
    };
}

async function createTaskLog({ tokenPreview, sessionPayload, cdkCode, phone, cardLast4, status, progress = 0 }) {
    const now = new Date();
    const displayTime = now.toLocaleString('zh-CN', { hour12: false });
    const jobKey = `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
    const message = String(status) === 'running' ? '正在开通中' : null;

    await runExecute(
        `INSERT INTO task_logs (job_key, token_preview, session_payload, cdk_code, phone, card_last4, status, message, progress, display_time, raw_output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            jobKey,
            String(tokenPreview),
            sessionPayload ? String(sessionPayload) : null,
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            String(status),
            message,
            Number(progress || 0),
            displayTime
        ]
    );

    return { jobKey, displayTime };
}

async function getTaskStatus(jobKey) {
    const rows = await runQuery(
        `SELECT status, message, progress, raw_output, cdk_code, phone, card_last4, failure_screenshots,
                gpt_api_order_id, gpt_api_task_id, gpt_api_raw, gpt_api_topup_code
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [String(jobKey)]
    );
    return rows[0] || null;
}

async function getRunningTaskByCdk(cdk) {
    const rows = await runQuery(
        `SELECT job_key, status, message, progress, updated_at
         FROM task_logs
         WHERE cdk_code = ?
           AND status = 'running'
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );
    return rows[0] || null;
}

async function deleteTaskLogByJobKey(jobKey) {
    const key = String(jobKey || '').trim();
    if (!key) {
        return { deleted: 0, mediaDeleted: 0 };
    }
    const rows = await runQuery(
        `SELECT raw_output, failure_screenshots
         FROM task_logs
         WHERE job_key = ?
         LIMIT 1`,
        [key]
    );
    let mediaDeleted = 0;
    if (rows.length) {
        mediaDeleted = deleteTaskMediaFiles(rows[0]).deleted;
    }
    const result = await runExecute('DELETE FROM task_logs WHERE job_key = ? LIMIT 1', [key]);
    return { deleted: Number(result.affectedRows || 0), mediaDeleted };
}

async function updateTaskLog(jobKey, { status, message, rawOutput, cdkCode, phone, cardLast4, progress, failureScreenshots, gptApiOrderId, gptApiTaskId, gptApiRaw, gptApiTopupCode }) {
    const screenshotsJson = Array.isArray(failureScreenshots)
        ? JSON.stringify(failureScreenshots)
        : null;
    await runExecute(
        `UPDATE task_logs
         SET status = ?,
             message = COALESCE(?, message),
             raw_output = COALESCE(?, raw_output),
             progress = GREATEST(progress, COALESCE(?, progress)),
             cdk_code = COALESCE(?, cdk_code),
             phone = COALESCE(?, phone),
             card_last4 = COALESCE(?, card_last4),
             failure_screenshots = COALESCE(?, failure_screenshots),
             gpt_api_order_id = COALESCE(?, gpt_api_order_id),
             gpt_api_task_id = COALESCE(?, gpt_api_task_id),
             gpt_api_raw = COALESCE(?, gpt_api_raw),
             gpt_api_topup_code = COALESCE(?, gpt_api_topup_code)
         WHERE job_key = ?`,
        [
            String(status),
            message || null,
            rawOutput || null,
            progress == null ? null : Number(progress),
            cdkCode || null,
            phone || null,
            cardLast4 || null,
            screenshotsJson,
            gptApiOrderId || null,
            gptApiTaskId || null,
            gptApiRaw || null,
            gptApiTopupCode || null,
            String(jobKey)
        ]
    );
}

async function listProducts() {
    const rows = await runQuery(
        `SELECT p.id,
                p.email,
                p.imap_key,
                COALESCE(
                    p.claimed_cdk,
                    (
                        SELECT l.cdk_code
                        FROM task_logs l
                        WHERE l.status = 'success'
                          AND l.cdk_code IS NOT NULL
                          AND l.cdk_code <> ''
                          AND l.message LIKE CONCAT('%', p.email, '%')
                        ORDER BY l.created_at DESC, l.id DESC
                        LIMIT 1
                    )
                ) AS claimed_cdk,
                p.file_path,
                p.status,
                p.shipped,
                p.created_at
         FROM product_assets p
         ORDER BY p.id DESC`
    );
    return rows.map(row => ({
        ...row,
        time: new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
    }));
}

async function addProduct(email, filePath, password = null, token = null, imapKey = null) {
    await runExecute(
        `INSERT INTO product_assets (email, file_path, password, token, imap_key) 
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), password = VALUES(password), token = VALUES(token), imap_key = COALESCE(VALUES(imap_key), imap_key)`,
        [email, filePath, password, token, imapKey]
    );
}

// 支付成功立即入库（占位）：file_path 留空，status='待协议'
// 后续 oauth_login 拿到 RT 后再调用 markProductReadyByEmail() 升级为 '正常'
async function upsertPendingProduct(email, accessToken = null) {
    if (!email) return;
    await runExecute(
        `INSERT INTO product_assets (email, token, status)
         VALUES (?, ?, '待协议')
         ON DUPLICATE KEY UPDATE token = COALESCE(VALUES(token), token)`,
        [String(email), accessToken ? String(accessToken) : null]
    );
}

// 协议提取成功后调用：补 file_path / imap_key，并把状态翻成 '正常'，使其可被 CDK 兑换
async function markProductReadyByEmail(email, filePath = '', imapKey = null) {
    if (!email) return;
    await runExecute(
        `UPDATE product_assets
         SET file_path = CASE WHEN ? <> '' THEN ? ELSE file_path END,
             imap_key = COALESCE(?, imap_key),
             status = '正常'
         WHERE email = ?`,
        [String(filePath || ''), String(filePath || ''), imapKey ? String(imapKey) : null, String(email)]
    );
}

async function updateProductImapKeyByEmail(email, imapKey) {
    await runExecute(
        `UPDATE product_assets SET imap_key = ? WHERE email = ?`,
        [imapKey ? String(imapKey) : null, String(email)]
    );
}

async function updateProductClaimedCdkByEmail(email, claimedCdk) {
    await runExecute(
        `UPDATE product_assets SET claimed_cdk = ? WHERE email = ?`,
        [claimedCdk ? String(claimedCdk) : null, String(email)]
    );
}

async function deleteProduct(id) {
    await runExecute(`DELETE FROM product_assets WHERE id = ?`, [id]);
}

async function updateProductStatus(id, status) {
    await runExecute(`UPDATE product_assets SET status = ? WHERE id = ?`, [status, id]);
}

async function claimProductAccount(cdk) {
    return withTransaction(async (connection) => {
        // 1. 验证 CDK
        const [cdkRows] = await connection.query(
            `SELECT * FROM cdk_codes WHERE cdk_code = ? AND is_active = 1 AND used_at IS NULL AND type = '成品' FOR UPDATE`,
            [cdk]
        );
        const cdkData = cdkRows[0];
        if (!cdkData) {
            throw new Error('CDK 无效、已使用或非成品激活码');
        }

        // 2. 查找可用成品账号
        const [productRows] = await connection.query(
            `SELECT * FROM product_assets WHERE shipped = 0 AND status = '正常' ORDER BY id ASC LIMIT 1 FOR UPDATE`
        );
        const product = productRows[0];
        if (!product) {
            throw new Error('当前成品号库暂时缺货，请联系客服补充');
        }

        // 3. 标记 CDK 已使用
        await connection.query(
            `UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [cdkData.id]
        );

        // 4. 标记成品号已出库
        await connection.query(
            `UPDATE product_assets SET shipped = 1, claimed_cdk = ? WHERE id = ?`,
            [String(cdk), product.id]
        );

        // 5. 创建成功日志
        const jobKey = `PROD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        await connection.query(
            `INSERT INTO task_logs (job_key, token_preview, cdk_code, status, message, progress, display_time)
             VALUES (?, ?, ?, 'success', ?, 100, ?)`,
            [
                jobKey,
                'PRODUCT_CLAIM',
                cdk,
                `成品号兑换成功: ${product.email}`,
                new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            ]
        );

        return {
            email: product.email,
            password: product.password,
            token: product.token,
            imapKey: product.imap_key || '',
            jobKey
        };
    });
}

async function updateProductStatusByEmail(email, status) {
    await runExecute(`UPDATE product_assets SET status = ? WHERE email = ?`, [status, email]);
}

async function updateProductStatusByEmails(emails, status) {
    const normalizedEmails = [...new Set(
        (Array.isArray(emails) ? emails : [])
            .map((item) => String(item || '').trim().toLowerCase())
            .filter(Boolean)
    )];

    if (normalizedEmails.length === 0) {
        return 0;
    }

    const placeholders = normalizedEmails.map(() => '?').join(', ');
    const result = await runExecute(
        `UPDATE product_assets SET status = ? WHERE LOWER(email) IN (${placeholders})`,
        [status, ...normalizedEmails]
    );
    return Number(result?.affectedRows || 0);
}

async function markProductShipped(id, shipped = 1) {
    await runExecute(`UPDATE product_assets SET shipped = ? WHERE id = ?`, [shipped, id]);
}

async function markProductShippedByEmail(email, shipped = 1) {
    await runExecute(`UPDATE product_assets SET shipped = ? WHERE email = ?`, [shipped, email]);
}

async function getClaimedProductDownloadInfo(cdk) {
    const logRows = await runQuery(
        `SELECT message, raw_output
         FROM task_logs
         WHERE cdk_code = ?
           AND status = 'success'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [String(cdk)]
    );

    const logRow = logRows[0] || null;
    if (!logRow) {
        return null;
    }

    const message = String(logRow.message || '');
    let email = '';
    let filePath = '';
    let imapKey = '';

    const messageMatch = message.match(/成品号(?:兑换|创建)成功:\s*(.+)$/);
    if (messageMatch) {
        email = String(messageMatch[1] || '').trim();
    }

    try {
        const parsed = logRow.raw_output ? JSON.parse(logRow.raw_output) : null;
        if (!email) {
            email = String(parsed?.email || '').trim();
        }
        filePath = String(parsed?.sub2apiPath || parsed?.filePath || '').trim();
        imapKey = String(parsed?.imapKey || '').trim();
    } catch (_) { }

    if (filePath && imapKey) {
        return {
            email,
            filePath,
            imapKey
        };
    }

    if (!email) {
        const claimedRows = await runQuery(
            `SELECT email, imap_key, file_path
             FROM product_assets
             WHERE claimed_cdk = ?
             ORDER BY id DESC
             LIMIT 1`,
            [String(cdk)]
        );
        const claimedProduct = claimedRows[0];
        if (!claimedProduct || !claimedProduct.file_path) {
            return null;
        }
        return {
            email: claimedProduct.email,
            filePath: filePath || claimedProduct.file_path,
            imapKey: imapKey || claimedProduct.imap_key || ''
        };
    }

    const productRows = await runQuery(
        `SELECT email, imap_key, file_path, status, shipped
         FROM product_assets
         WHERE email = ?
         ORDER BY id DESC
         LIMIT 1`,
        [email]
    );
    const product = productRows[0];
    if (!product || !product.file_path) {
        return null;
    }

    return {
        email: product.email,
        filePath: filePath || product.file_path,
        imapKey: imapKey || product.imap_key || ''
    };
}

// ─── Card Pool Enhanced Methods ────────────────────────────────────────────────

async function hasAvailableCard() {
    const policy = await getCardPolicy();
    const rows = await runQuery(
        `SELECT id
         FROM card_assets
         WHERE is_active = 1
           AND in_use = 0
           AND status = '正常'
           AND usage_count < ?
         LIMIT 1`,
        [policy.maxSubscriptionCount]
    );
    return rows.length > 0;
}

async function reserveCard(ownerKey, excludedCardIds) {
    const policy = await getCardPolicy();
    const excludedIds = Array.isArray(excludedCardIds)
        ? [...new Set(excludedCardIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
        : [];
    const excludedClause = excludedIds.length
        ? ` AND id NOT IN (${excludedIds.map(() => '?').join(', ')})`
        : '';
    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            `SELECT id, card_number, card_expiry, card_cvc, card_holder, usage_count, decline_count
             FROM card_assets
             WHERE is_active = 1
               AND in_use = 0
               AND status = '正常'
               AND usage_count < ?${excludedClause}
             ORDER BY usage_count ASC, COALESCE(last_used_at, '1970-01-01') ASC, id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [policy.maxSubscriptionCount, ...excludedIds]
        );

        if (!rows.length) {
            return null;
        }

        const row = rows[0];
        await connection.query(
            `UPDATE card_assets
             SET in_use = 1,
                 locked_at = CURRENT_TIMESTAMP,
                 locked_by = ?
             WHERE id = ?`,
            [String(ownerKey || '').slice(0, 64) || null, row.id]
        );

        return {
            id: row.id,
            card_number: row.card_number,
            card_expiry: row.card_expiry,
            card_cvc: row.card_cvc,
            card_holder: row.card_holder,
            usage_count: Number(row.usage_count || 0),
            decline_count: Number(row.decline_count || 0)
        };
    });
}

/**
 * 释放卡片锁定。
 * @param {number} cardId - 卡片 ID
 */
async function releaseCard(cardId) {
    if (!cardId) {
        return;
    }
    await runExecute(
        `UPDATE card_assets
         SET in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE id = ?`,
        [Number(cardId)]
    );
}

async function recordCardUsage(cardId) {
    if (!cardId) {
        return { usageCount: 0, exhausted: false };
    }

    const policy = await getCardPolicy();
    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            `SELECT usage_count
             FROM card_assets
             WHERE id = ?
             FOR UPDATE`,
            [Number(cardId)]
        );

        if (!rows.length) {
            return { usageCount: 0, exhausted: false };
        }

        const row = rows[0];
        const usageCount = Number(row.usage_count || 0) + 1;
        const exhausted = usageCount >= policy.maxSubscriptionCount;
        await connection.query(
            `UPDATE card_assets
             SET usage_count = ?,
                 decline_count = 0,
                 last_used_at = NOW(),
                 is_active = ?,
                 status = ?
             WHERE id = ?`,
            [
                usageCount,
                exhausted ? 0 : 1,
                exhausted ? '订阅额度用尽' : '正常',
                Number(cardId)
            ]
        );
        return { usageCount, exhausted };
    });
}

async function recordCardDecline(cardId) {
    if (!cardId) {
        return { declineCount: 0, exhausted: false };
    }

    const policy = await getCardPolicy();
    return withTransaction(async (connection) => {
        const [rows] = await connection.query(
            `SELECT decline_count
             FROM card_assets
             WHERE id = ?
             FOR UPDATE`,
            [Number(cardId)]
        );
        if (!rows.length) {
            return { declineCount: 0, exhausted: false };
        }

        const declineCount = Number(rows[0].decline_count || 0) + 1;
        const exhausted = declineCount >= policy.maxDeclineCount;
        await connection.query(
            `UPDATE card_assets
             SET decline_count = ?,
                 is_active = ?,
                 status = ?
             WHERE id = ?`,
            [
                declineCount,
                exhausted ? 0 : 1,
                exhausted ? '已报废' : '正常',
                Number(cardId)
            ]
        );
        return { declineCount, exhausted };
    });
}

const reconcileCardSubscriptionLimit = async (maxSubscriptionCount, connection) => {
    await runExecute(
        `UPDATE card_assets
         SET is_active = 0,
             status = '订阅额度用尽',
             in_use = 0,
             locked_at = NULL,
             locked_by = NULL
         WHERE usage_count >= ?
           AND status = '正常'`,
        [maxSubscriptionCount],
        { connection }
    );
    await runExecute(
        `UPDATE card_assets
         SET is_active = 1,
             status = '正常'
         WHERE usage_count < ?
           AND status = '订阅额度用尽'
           AND in_use = 0`,
        [maxSubscriptionCount],
        { connection }
    );
};

/**
 * 支付成功后，将持卡人姓名与免税地址绑定到卡片记录
 * @param {number} cardId
 * @param {{ holderName?: string, address?: object }} profile
 */
async function bindCardPaymentProfile(cardId, profile = {}) {
    if (!cardId) return;
    const holderName = String(profile.holderName || '').trim();
    const address = profile.address || {};
    const addressId = Number(address.id) > 0 ? Number(address.id) : null;
    await runExecute(
        `UPDATE card_assets
         SET payment_holder_name = ?,
             payment_address_line1 = ?,
             payment_address_city = ?,
             payment_address_state = ?,
             payment_address_postal = ?,
             payment_address_id = ?
         WHERE id = ?`,
        [
            holderName,
            String(address.line1 || ''),
            String(address.city || ''),
            String(address.state || ''),
            String(address.postal_code || ''),
            addressId,
            Number(cardId)
        ]
    );
}

// ─── Card Import ─────────────────────────────────────────────────────────────

const { validateCard } = require('./card-validator');

/**
 * 批量导入信用卡（含格式验证 + 去重）。
 * - 单次上限 500 张，超出直接抛错
 * - 对每张卡执行 validateCard；验证不通过计入 failed
 * - 验证通过后检查数据库是否已存在相同 card_number，存在则计入 skipped
 * - 剩余的卡片插入数据库，计入 imported
 * - imported + skipped + failed 始终等于输入数组长度
 *
 * @param {Array<{ card_number: string, card_expiry: string, card_cvc: string, card_holder?: string }>} cards
 * @returns {Promise<{ imported: number, skipped: number, failed: number, failures: Array<{ index: number, errors: string[] }> }>}
 */
async function importCards(cards) {
    if (!Array.isArray(cards)) {
        throw new Error('cards 参数必须为数组');
    }

    if (cards.length > 500) {
        throw new Error('单次导入上限 500 条');
    }

    const failures = []; // { index, errors }
    const validCards = [];  // { index, card_number, card_expiry, card_cvc, card_holder }

    // Step 1: Validate each card
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const result = validateCard(card);
        if (!result.valid) {
            failures.push({ index: i, errors: result.errors });
        } else {
            validCards.push({
                index: i,
                card_number: String(card.card_number).trim(),
                card_expiry: String(card.card_expiry).trim(),
                card_cvc: String(card.card_cvc).trim(),
                card_holder: String(card.card_holder || '').trim()
            });
        }
    }

    if (validCards.length === 0) {
        return {
            imported: 0,
            skipped: 0,
            failed: failures.length,
            failures
        };
    }

    // Step 2: Check for duplicates in database
    const cardNumbers = validCards.map((c) => c.card_number);
    const placeholders = cardNumbers.map(() => '?').join(', ');
    const existingRows = await runQuery(
        `SELECT card_number FROM card_assets WHERE card_number IN (${placeholders})`,
        cardNumbers
    );
    const existingSet = new Set(existingRows.map((r) => r.card_number));

    const toInsert = [];
    let skipped = 0;

    for (const card of validCards) {
        if (existingSet.has(card.card_number)) {
            skipped++;
        } else {
            toInsert.push(card);
        }
    }

    // Step 3: Insert new cards (also deduplicate within the batch itself)
    let imported = 0;
    const seenInBatch = new Set();

    for (const card of toInsert) {
        if (seenInBatch.has(card.card_number)) {
            skipped++;
            continue;
        }
        seenInBatch.add(card.card_number);

        try {
            await runExecute(
                `INSERT INTO card_assets (card_number, card_expiry, card_cvc, card_holder, sort_order, is_active, status)
                 VALUES (?, ?, ?, ?, 0, 1, '正常')`,
                [card.card_number, card.card_expiry, card.card_cvc, card.card_holder]
            );
            imported++;
        } catch (err) {
            // Duplicate key error (in case of race condition)
            if (err.message && err.message.includes('Duplicate')) {
                skipped++;
            } else {
                failures.push({ index: card.index, errors: [err.message || '插入失败'] });
            }
        }
    }

    return {
        imported,
        skipped,
        failed: failures.length,
        failures
    };
}

// ─── Region Selector ────────────────────────────────────────────────────────

const { SUPPORTED_REGIONS, DEFAULT_REGION } = require('./region-config');

/**
 * 获取当前支付地区代码
 * @returns {Promise<string>} 地区代码（如 'PH'）
 */
async function getPaymentRegion() {
    const value = await getAppConfigValue('payment_region', DEFAULT_REGION);
    // 如果数据库中的值无效，返回默认值
    if (!SUPPORTED_REGIONS.includes(value)) {
        return DEFAULT_REGION;
    }
    return value;
}

/**
 * 设置支付地区代码（需校验合法性）
 * @param {string} regionCode - 地区代码
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function setPaymentRegion(regionCode) {
    const code = String(regionCode || '').toUpperCase();
    if (!SUPPORTED_REGIONS.includes(code)) {
        return { success: false, error: '不支持的地区代码' };
    }
    await setAppConfigValue('payment_region', code);
    return { success: true };
}

// ─── Billing Recorder ───────────────────────────────────────────────────────

/**
 * 创建账单记录
 * @param {object} data - 账单数据
 * @returns {Promise<number>} 插入记录的 ID
 */
async function createBillingRecord(data) {
    const result = await runExecute(
        `INSERT INTO billing_records
            (payment_time, card_number, card_last4, amount, currency, plan_type, stripe_session_id, cdk_code, email, status, error_code, error_message)
         VALUES (COALESCE(?, NOW()), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.payment_time || null,
            data.card_number ? String(data.card_number) : null,
            String(data.card_last4 || ''),
            Number(data.amount || 0),
            String(data.currency || 'USD'),
            String(data.plan_type || 'plus'),
            data.stripe_session_id || null,
            data.cdk_code || null,
            data.email || null,
            String(data.status || 'success'),
            data.error_code || null,
            data.error_message || null
        ]
    );
    return result.insertId;
}

/**
 * 查询账单列表（分页 + 筛选）
 * @param {object} filters - { startDate, endDate, cardLast4, planType, status }
 * @param {number} page - 页码（从 1 开始）
 * @param {number} pageSize - 每页条数（默认 20）
 * @returns {Promise<{ records: Array, total: number, page: number, pageSize: number }>}
 */
async function listBillingRecords(filters = {}, page = 1, pageSize = 20) {
    page = Math.max(1, Number(page) || 1);
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));

    const conditions = [];
    const params = [];

    if (filters.startDate) {
        conditions.push('payment_time >= ?');
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        conditions.push('payment_time <= ?');
        params.push(filters.endDate);
    }
    if (filters.cardLast4) {
        conditions.push('card_last4 = ?');
        params.push(String(filters.cardLast4));
    }
    if (filters.planType) {
        conditions.push('plan_type = ?');
        params.push(String(filters.planType));
    }
    if (filters.status) {
        conditions.push('status = ?');
        params.push(String(filters.status));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRows = await runQuery(
        `SELECT COUNT(*) AS total FROM billing_records ${whereClause}`,
        params
    );
    const total = Number(countRows[0]?.total || 0);

    const offset = (page - 1) * pageSize;
    const records = await runQuery(
        `SELECT id, payment_time, card_number, card_last4, amount, currency, plan_type, stripe_session_id, cdk_code, email, status, error_code, error_message, created_at
         FROM billing_records
         ${whereClause}
         ORDER BY payment_time DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
    );

    return { records, total, page, pageSize };
}

/**
 * 导出账单为 UTF-8 CSV（带 BOM），最多 10000 行
 * @param {object} filters - 同 listBillingRecords 的 filters
 * @returns {Promise<string>} CSV 字符串
 */
async function exportBillingRecordsCSV(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.startDate) {
        conditions.push('payment_time >= ?');
        params.push(filters.startDate);
    }
    if (filters.endDate) {
        conditions.push('payment_time <= ?');
        params.push(filters.endDate);
    }
    if (filters.cardLast4) {
        conditions.push('card_last4 = ?');
        params.push(String(filters.cardLast4));
    }
    if (filters.planType) {
        conditions.push('plan_type = ?');
        params.push(String(filters.planType));
    }
    if (filters.status) {
        conditions.push('status = ?');
        params.push(String(filters.status));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await runQuery(
        `SELECT payment_time, card_number, card_last4, amount, currency, plan_type, stripe_session_id, cdk_code, email, status, error_code, error_message
         FROM billing_records
         ${whereClause}
         ORDER BY payment_time DESC
         LIMIT 10000`,
        params
    );

    const BOM = '\uFEFF';
    const headers = '支付时间,卡号,卡片后四位,金额,币种,套餐类型,Stripe Session ID,CDK码,邮箱,状态,错误码,错误信息';

    const csvRows = rows.map((row) => {
        const paymentTime = row.payment_time
            ? new Date(row.payment_time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
            : '';
        return [
            paymentTime,
            row.card_number || '',
            row.card_last4 || '',
            row.amount || '0',
            row.currency || '',
            row.plan_type || '',
            row.stripe_session_id || '',
            row.cdk_code || '',
            row.email || '',
            row.status || '',
            row.error_code || '',
            row.error_message || ''
        ].map((field) => {
            const str = String(field);
            // CSV 字段包含逗号、引号或换行时需要引号包裹
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(',');
    });

    return BOM + headers + '\n' + csvRows.join('\n');
}

async function deleteBillingRecord(id) {
    const result = await runExecute(
        `DELETE FROM billing_records WHERE id = ?`,
        [Number(id)]
    );
    return result.affectedRows > 0;
}

async function deleteFailedBillingRecords() {
    const result = await runExecute(
        `DELETE FROM billing_records WHERE status = 'failed'`
    );
    return Number(result.affectedRows || 0);
}

/**
 * 卡片消费汇总
 * @param {string} cardLast4 - 卡片后四位
 * @returns {Promise<{ cumulative_amount: number, success_count: number, failed_count: number }>}
 */
async function getCardBillingSummary(cardLast4) {
    const rows = await runQuery(
        `SELECT
            COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) AS cumulative_amount,
            COALESCE(SUM(status = 'success'), 0) AS success_count,
            COALESCE(SUM(status = 'failed'), 0) AS failed_count
         FROM billing_records
         WHERE card_last4 = ?`,
        [String(cardLast4)]
    );

    const row = rows[0] || {};
    return {
        cumulative_amount: Number(row.cumulative_amount || 0),
        success_count: Number(row.success_count || 0),
        failed_count: Number(row.failed_count || 0)
    };
}

async function listRecentGptApiOrders(limit = 10) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    return runQuery(
        `SELECT job_key, cdk_code, status, message, progress, updated_at,
                gpt_api_order_id, gpt_api_task_id, gpt_api_topup_code, gpt_api_raw
         FROM task_logs
         WHERE (gpt_api_order_id IS NOT NULL OR gpt_api_task_id IS NOT NULL)
           AND status = 'failed'
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [safeLimit]
    );
}

module.exports = {
    runQuery,
    runExecute,
    ensureReady,
    getAdminData,
    listAdminTaskLogs,
    getResumableAdminProductGeneration,
    saveConfig,
    getAdminAuthConfig,
    updateAdminPassword,
    updateAdminEmail,
    updateAdminSecondaryPassword,
    saveAdminTotpConfig,
    saveAdmin2faLoginMode,
    getAdminPaths,
    saveAdminPaths,
    insertAdminLoginLog,
    listAdminLoginLogs,
    listCdks,
    listSessions,
    markCdkShipped,
    insertCdks,
    deleteCdk,
    verifyCdk,
    verifyCdkDetails,
    markCdkUsed,
    markCdkUnused,
    recordCdkFailure,
    resetCdkFailure,
    getActivationAttemptLimit,
    recordActivationAttemptFailure,
    resetActivationAttemptFailure,
    deletePhoneAsset,
    deleteCardAsset,
    bulkImportPoolEmails,
    listPoolEmails,
    getPoolEmailCredentials,
    deletePoolEmail,
    reservePoolEmail,
    releasePoolEmailReservation,
    markPoolEmailRegistered,
    getRuntimeAssets,
    reserveRuntimeAssets,
    releaseRuntimeAssets,
    releaseStaleAssetLocks,
    resetAllAssetLocks,
    getActiveProxy,
    listProxyAssets,
    addProxyAssets,
    deleteProxyAsset,
    setProxyAssetActive,
    updateProxyAssetCheck,
    getProxyAssetById,
    incrementAssetSuccessCount,
    getAppConfigValue,
    setAppConfigValue,
    getBrowserPoolEnabled,
    setBrowserPoolEnabled,
    getTelegramConfig,
    saveTelegramConfig,
    getGptApiConfig,
    saveGptApiConfig,
    getHcaptchaConfig,
    saveHcaptchaConfig,
    syncHcaptchaConfigPersistence,
    publicHcaptchaConfig,
    getMaxConcurrentActivations,
    getMaxBackgroundConcurrent,
    getMaintenanceModeState,
    setMaintenanceModeState,
    createTaskLog,
    deleteTaskLogByJobKey,
    deleteTaskMediaFiles,
    getBillingOverviewStats,
    getTaskStatus,
    getRunningTaskByCdk,
    updateTaskLog,
    listRecentGptApiOrders,
    listProducts,
    addProduct,
    upsertPendingProduct,
    markProductReadyByEmail,
    updateProductImapKeyByEmail,
    updateProductClaimedCdkByEmail,
    deleteProduct,
    updateProductStatus,
    updateProductStatusByEmail,
    updateProductStatusByEmails,
    markProductShipped,
    markProductShippedByEmail,
    claimProductAccount,
    getClaimedProductDownloadInfo,
    reserveCard,
    hasAvailableCard,
    releaseCard,
    recordCardUsage,
    recordCardDecline,
    bindCardPaymentProfile,
    importCards,
    getPaymentRegion,
    setPaymentRegion,
    createBillingRecord,
    listBillingRecords,
    exportBillingRecordsCSV,
    getCardBillingSummary,
    deleteBillingRecord,
    deleteFailedBillingRecords,
    getSessionByJobKey,
    PLAN_NAME_MAP,
    resolvePlanName,
    connectionInfo: {
        host: DB_HOST,
        port: DB_PORT,
        database: DB_NAME,
        user: DB_USER
    }
};
