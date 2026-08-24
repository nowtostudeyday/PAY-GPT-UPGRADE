CREATE TABLE IF NOT EXISTS app_config (
    config_key VARCHAR(64) NOT NULL PRIMARY KEY,
    config_value TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    sms_api_key VARCHAR(255) NOT NULL DEFAULT '',
    usage_count INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_phone_assets_phone (phone),
    KEY idx_phone_assets_sort (sort_order, id),
    KEY idx_phone_assets_pick (is_active, in_use, locked_at, usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    card_number VARCHAR(32) NOT NULL,
    card_expiry VARCHAR(16) NOT NULL DEFAULT '',
    card_cvc VARCHAR(16) NOT NULL DEFAULT '',
    card_holder VARCHAR(128) NOT NULL DEFAULT '' COMMENT '持卡人姓名',
    usage_count INT NOT NULL DEFAULT 0,
    decline_count INT NOT NULL DEFAULT 0 COMMENT '明确拒付次数',
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    last_used_at TIMESTAMP NULL DEFAULT NULL COMMENT '最后使用时间',
    daily_usage_count INT NOT NULL DEFAULT 0 COMMENT '24h 内使用次数',
    daily_usage_reset_at TIMESTAMP NULL DEFAULT NULL COMMENT '24h 计数重置时间',
    cooldown_until TIMESTAMP NULL DEFAULT NULL COMMENT '冷却截止时间',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_card_assets_sort (sort_order, id),
    KEY idx_card_assets_pick (is_active, in_use, locked_at, usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webhook_event_receipts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(32) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    imported_count INT NOT NULL DEFAULT 0,
    skipped_count INT NOT NULL DEFAULT 0,
    error_message VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_webhook_event_receipts_provider_event (provider, event_id),
    KEY idx_webhook_event_receipts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cdk_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cdk_code VARCHAR(32) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped_at TIMESTAMP NULL DEFAULT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    type VARCHAR(16) NOT NULL DEFAULT '自助',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro_5x/pro_20x',
    fail_count INT DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_cdk_codes_code (cdk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_key VARCHAR(64) NOT NULL,
    token_preview VARCHAR(64) NOT NULL,
    session_payload MEDIUMTEXT NULL,
    cdk_code VARCHAR(32) NULL,
    phone VARCHAR(32) NULL,
    card_last4 VARCHAR(4) NULL,
    status VARCHAR(32) NOT NULL,
    message VARCHAR(255) NULL,
    progress INT NOT NULL DEFAULT 0,
    display_time VARCHAR(64) NOT NULL,
    raw_output MEDIUMTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_task_logs_job_key (job_key),
    KEY idx_task_logs_created (created_at),
    KEY idx_task_logs_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activation_attempt_limits (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    scope_type VARCHAR(16) NOT NULL,
    scope_key VARCHAR(128) NOT NULL,
    fail_count INT NOT NULL DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_activation_attempt_scope (scope_type, scope_key),
    KEY idx_activation_attempt_cooldown (cooldown_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    imap_key VARCHAR(64) NULL,
    claimed_cdk VARCHAR(32) NULL,
    password VARCHAR(255) NULL,
    token TEXT NULL,
    file_path VARCHAR(512) NULL,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_product_assets_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pool_emails (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(512) NOT NULL DEFAULT '',
    client_id VARCHAR(128) NOT NULL DEFAULT '',
    refresh_token TEXT NULL,
    registered TINYINT(1) NOT NULL DEFAULT 0,
    registered_at TIMESTAMP NULL DEFAULT NULL,
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_pool_emails_email (email),
    KEY idx_pool_emails_pick (registered, is_active, in_use, locked_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tax_free_addresses (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    region VARCHAR(4) NOT NULL COMMENT '地区代码 PH/US/SG/MY',
    line1 VARCHAR(200) NOT NULL COMMENT '街道地址',
    city VARCHAR(100) NOT NULL COMMENT '城市',
    state VARCHAR(100) NOT NULL COMMENT '州/省',
    postal_code VARCHAR(20) NOT NULL COMMENT '邮政编码',
    country VARCHAR(2) NOT NULL COMMENT 'ISO 3166-1 alpha-2',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_tax_free_region (region, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS proxy_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    proxy_url TEXT NOT NULL COMMENT '完整代理 URL，支持 {session}',
    proxy_url_hash CHAR(64) NOT NULL COMMENT 'URL SHA256，用于去重',
    label VARCHAR(128) NOT NULL DEFAULT '' COMMENT '可选备注',
    protocol VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'http/socks5 等',
    host VARCHAR(255) NOT NULL DEFAULT '' COMMENT '代理主机',
    is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1=启用参与任务抽取',
    last_check_at TIMESTAMP NULL DEFAULT NULL,
    last_check_ok TINYINT(1) NULL DEFAULT NULL COMMENT '1=通过 0=失败 NULL=未测',
    last_check_ip VARCHAR(64) NOT NULL DEFAULT '',
    last_check_latency_ms INT NULL DEFAULT NULL,
    last_check_error VARCHAR(512) NOT NULL DEFAULT '',
    usage_count INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_proxy_url_hash (proxy_url_hash),
    KEY idx_proxy_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_records (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    payment_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '支付时间',
    card_last4 VARCHAR(4) NOT NULL COMMENT '卡片后四位',
    card_number VARCHAR(32) NULL COMMENT '完整卡号',
    amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '支付金额',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD' COMMENT '币种',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro_5x/pro_20x',
    stripe_session_id VARCHAR(128) NULL COMMENT 'Stripe Session ID',
    cdk_code VARCHAR(32) NULL COMMENT '关联 CDK',
    email VARCHAR(255) NULL COMMENT '关联邮箱',
    status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success/failed',
    error_code VARCHAR(64) NULL COMMENT 'Stripe 错误码',
    error_message VARCHAR(512) NULL COMMENT '失败原因',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_billing_time (payment_time),
    KEY idx_billing_card (card_last4),
    KEY idx_billing_plan (plan_type),
    KEY idx_billing_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_login_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event VARCHAR(32) NOT NULL COMMENT 'login_success/login_failed/2fa_failed/secondary_failed/secondary_success/password_changed/logout',
    admin_email VARCHAR(128) NULL DEFAULT NULL,
    ip VARCHAR(45) NULL DEFAULT NULL,
    user_agent VARCHAR(512) NULL DEFAULT NULL,
    fingerprint VARCHAR(128) NULL DEFAULT NULL,
    detail VARCHAR(512) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_admin_login_created (created_at),
    KEY idx_admin_login_event (event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
