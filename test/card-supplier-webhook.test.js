'use strict';

const crypto = require('crypto');
const {
    CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT,
    createCardSupplierWebhookSignature,
    verifyCardSupplierWebhook,
    decryptCardSupplierIssuedCards
} = require('../card-supplier-webhook');

const WEBHOOK_SECRET = 'whsec_test_card_supplier_webhook_secret';

const encryptSensitiveValue = (value) => {
    const key = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update('vcc-webhook-sensitive-v1')
        .digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
};

const createPayload = () => ({
    eventId: 'card_issue_test_001',
    eventType: CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT,
    data: {
        cards: [{
            cardId: 'VC_TEST_001',
            cardNumberCiphertext: encryptSensitiveValue('4242424242424242'),
            expiryDateCiphertext: encryptSensitiveValue('12/2029'),
            cvvCiphertext: encryptSensitiveValue('123')
        }]
    }
});

const createHeaders = (payload, rawBody) => {
    const timestamp = '1780000000000';
    const nonce = 'card-supplier-test-nonce';
    return {
        'x-vcc-webhook-id': payload.eventId,
        'x-vcc-webhook-event': payload.eventType,
        'x-vcc-webhook-timestamp': timestamp,
        'x-vcc-webhook-nonce': nonce,
        'x-vcc-webhook-signature': createCardSupplierWebhookSignature({
            eventId: payload.eventId,
            eventType: payload.eventType,
            timestamp,
            nonce,
            rawBody,
            webhookSecret: WEBHOOK_SECRET
        })
    };
};

describe('card supplier webhook', () => {
    it('validates a signed raw payload and decrypts issued cards', () => {
        const payload = createPayload();
        const rawBody = Buffer.from(JSON.stringify(payload));
        const verification = verifyCardSupplierWebhook({
            headers: createHeaders(payload, rawBody),
            payload,
            rawBody,
            webhookSecret: WEBHOOK_SECRET
        });

        expect(verification).toMatchObject({
            valid: true,
            eventId: payload.eventId,
            eventType: CARD_SUPPLIER_CARD_ISSUE_SUCCESS_EVENT
        });
        expect(decryptCardSupplierIssuedCards(payload, WEBHOOK_SECRET)).toEqual([{
            card_number: '4242424242424242',
            card_expiry: '12/29',
            card_cvc: '123',
            card_holder: ''
        }]);
    });

    it('rejects a signature when the raw payload changes', () => {
        const payload = createPayload();
        const signedRawBody = Buffer.from(JSON.stringify(payload));
        const alteredPayload = { ...payload, eventTime: '2026-08-24 12:00:00' };
        const verification = verifyCardSupplierWebhook({
            headers: createHeaders(payload, signedRawBody),
            payload: alteredPayload,
            rawBody: Buffer.from(JSON.stringify(alteredPayload)),
            webhookSecret: WEBHOOK_SECRET
        });

        expect(verification).toMatchObject({ valid: false });
    });

    it('rejects invalid encrypted card data', () => {
        const payload = createPayload();
        payload.data.cards[0].cvvCiphertext = 'invalid';

        expect(() => decryptCardSupplierIssuedCards(payload, WEBHOOK_SECRET)).toThrow('第 1 张卡 CVV');
    });
});
