'use strict';

const { matchesExpectedSubscriptionPlan } = require('../subscription-check');

describe('subscription plan validation', () => {
    it('accepts an active Plus subscription only for a Plus request', () => {
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, planKey: 'plus' }, 'plus')).toBe(true);
    });

    it('rejects an active Go subscription for a Plus request', () => {
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, planKey: 'go' }, 'plus')).toBe(false);
    });

    it('keeps Pro 5x and Pro 20x mutually exclusive', () => {
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'chatgptprolite' }, 'pro_5x')).toBe(true);
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'chatgptprolite' }, 'pro_20x')).toBe(false);
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'chatgptpro' }, 'pro_20x')).toBe(true);
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'chatgptpro' }, 'pro_5x')).toBe(false);
    });

    it('fails closed when OpenAI returns an ambiguous Pro plan name', () => {
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'pro' }, 'pro_5x')).toBe(false);
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: true, rawPlan: 'pro' }, 'pro_20x')).toBe(false);
    });

    it('rejects an inactive subscription even when the plan key matches', () => {
        expect(matchesExpectedSubscriptionPlan({ hasActiveSubscription: false, planKey: 'plus' }, 'plus')).toBe(false);
    });
});
