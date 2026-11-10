// Pure helpers, no k6 imports, so Node can unit-test them (service/test/tier.test.js).

export const ANON_CALLERS = 20;

// The tiers share the 100-VU cap of one profile (VU_CAP in arrivals.js).
export const TIER_VU_CAP = { normal: 20, noisy: 20, anonymous: 30 };

// A rate-limit 429 carries x-throttle: apigw (gateway response) or waf (WAF block action).
// A 429 without it is not a limit working, so it stays a failure. k6 may canonicalise the header name.
export function rateLimitedBy(status, headers = {}) {
  if (status !== 429) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-throttle');
  const value = key === undefined ? '' : String(headers[key]).toLowerCase();
  return value === 'apigw' || value === 'waf' ? value : null;
}

// Callers skip rate-limited requests before asking. Status 0 is a network error.
export const isAvailable = (status) => status > 0 && status < 500 && status !== 429;

// Caller index 1..n -> a distinct private address, 254 hosts per /24.
export const anonymousIp = (index) => `10.0.${Math.floor((index - 1) / 254)}.${((index - 1) % 254) + 1}`;
