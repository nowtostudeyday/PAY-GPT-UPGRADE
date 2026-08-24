'use strict';

const crypto = require('crypto');

const CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT = 'CARD_ISSUE.SUCCESS';
const CARD_SUPPLIER_SENSITIVE_KEY_CONTEXT = 'vcc-webhook-sensitive-v1';

const getHeader = (headers, name) => String(headers[name] || '').trim();

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

const createCardSupplierWebhookSignature = ({ eventId, eventType, timestamp, nonce, rawBody, webhookSecret }) => {
    const signatureBase = [
        eventId,
        eventType,
        timestamp,
        nonce,
        sha256Hex(rawBody)
    ].join('\n');
    const signature = crypto
        .createHmac('sha256', webhookSecret)
        .update(signatureBase)
        .digest('hex');
    return `v1=${signature}`;
};

const safeEqual = (left, right) => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyCardSupplierWebhook = ({ headers, payload, rawBody, webhookSecret }) => {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        return { valid: false, error: 'Webhook 请求体为空' };
    }
    if (!payload || typeof payload !== 'object') {
        return { valid: false, error: 'Webhook JSON 格式无效' };
    }

    const eventId = String(payload.eventId || '').trim();
    const eventType = String(payload.eventType || '').trim();
    const headerEventId = getHeader(headers, 'x-vcc-webhook-id');
    const headerEventType = getHeader(headers, 'x-vcc-webhook-event');
    const timestamp = getHeader(headers, 'x-vcc-webhook-timestamp');
    const nonce = getHeader(headers, 'x-vcc-webhook-nonce');
    const signature = getHeader(headers, 'x-vcc-webhook-signature');

    if (!eventId || !eventType || !headerEventId || !headerEventType || !timestamp || !nonce || !signature) {
        return { valid: false, error: 'Webhook 签名字段不完整' };
    }
    if (eventId !== headerEventId || eventType !== headerEventType) {
        return { valid: false, error: 'Webhook 事件头与正文不一致' };
    }
    if (!/^\d+$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/i.test(signature)) {
        return { valid: false, error: 'Webhook 签名字段格式无效' };
    }

    const expectedSignature = createCardSupplierWebhookSignature({
        eventId,
        eventType,
        timestamp,
        nonce,
        rawBody,
        webhookSecret
    });
    if (!safeEqual(signature.toLowerCase(), expectedSignature)) {
        return { valid: false, error: 'Webhook 签名校验失败' };
    }

    return {
        valid: true,
        eventId,
        eventType,
        payloadHash: sha256Hex(rawBody)
    };
};

const base64UrlToBuffer = (value, fieldName) => {
    const source = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(source)) {
        throw new Error(`${fieldName}密文格式无效`);
    }
    const paddingLength = (4 - (source.length % 4)) % 4;
    const normalized = `${source.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(paddingLength)}`;
    return Buffer.from(normalized, 'base64');
};

const deriveSensitiveKey = (webhookSecret) => crypto
    .createHmac('sha256', webhookSecret)
    .update(CARD_SUPPLIER_SENSITIVE_KEY_CONTEXT)
    .digest();

const decryptCardSupplierSensitiveValue = (ciphertext, webhookSecret, fieldName) => {
    const packed = base64UrlToBuffer(ciphertext, fieldName);
    if (packed.length < 29) {
        throw new Error(`${fieldName}密文长度无效`);
    }

    const iv = packed.subarray(0, 12);
    const authTag = packed.subarray(-16);
    const encrypted = packed.subarray(12, -16);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveSensitiveKey(webhookSecret), iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8').trim();
    } catch (_) {
        throw new Error(`${fieldName}解密失败`);
    }
};

const normalizeExpiry = (value) => {
    const expiry = String(value || '').trim();
    let match = expiry.match(/^(\d{2})\/(\d{2})$/);
    if (match) {
        return expiry;
    }
    match = expiry.match(/^(\d{2})\/(\d{4})$/);
    if (match) {
        return `${match[1]}/${match[2].slice(-2)}`;
    }
    match = expiry.match(/^(\d{4})-(\d{2})$/);
    if (match) {
        return `${match[2]}/${match[1].slice(-2)}`;
    }
    throw new Error('有效期格式不支持');
};

const decryptCardSupplierIssuedCards = (payload, webhookSecret) => {
    if (payload.eventType !== CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT) {
        return [];
    }
    const cards = payload.data?.cards;
    if (!Array.isArray(cards) || cards.length === 0) {
        throw new Error('开卡成功事件缺少卡片数据');
    }

    return cards.map((card, index) => ({
        card_number: decryptCardSupplierSensitiveValue(
            card?.cardNumberCiphertext,
            webhookSecret,
            `第 ${index + 1} 张卡号`
        ).replace(/[\s-]/g, ''),
        card_expiry: normalizeExpiry(decryptCardSupplierSensitiveValue(
            card?.expiryDateCiphertext,
            webhookSecret,
            `第 ${index + 1} 张卡有效期`
        )),
        card_cvc: decryptCardSupplierSensitiveValue(
            card?.cvvCiphertext,
            webhookSecret,
            `第 ${index + 1} 张卡 CVV`
        ),
        card_holder: ''
    }));
};

module.exports = {
    CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT,
    createCardSupplierWebhookSignature,
    verifyCardSupplierWebhook,
    decryptCardSupplierIssuedCards
};
