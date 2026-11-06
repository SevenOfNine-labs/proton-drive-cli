import { isAccessTokenExpired, resolveTokenExpiresAt } from './token-expiry';

describe('token expiry', () => {
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);

  describe('resolveTokenExpiresAt', () => {
    it('derives the expiry from ExpiresIn seconds', () => {
      expect(resolveTokenExpiresAt(3600, now)).toBe(now + 3_600_000);
    });

    it('reports no expiry when the API gave none (tokens are opaque)', () => {
      expect(resolveTokenExpiresAt(undefined, now)).toBeUndefined();
      expect(resolveTokenExpiresAt(0, now)).toBeUndefined();
      expect(resolveTokenExpiresAt(Number.NaN, now)).toBeUndefined();
    });
  });

  describe('isAccessTokenExpired', () => {
    it('is false without a known expiry', () => {
      expect(isAccessTokenExpired({}, now)).toBe(false);
    });

    it('turns true at the expiry instant', () => {
      expect(isAccessTokenExpired({ tokenExpiresAt: now + 1 }, now)).toBe(false);
      expect(isAccessTokenExpired({ tokenExpiresAt: now }, now)).toBe(true);
    });
  });
});
