/**
 * SessionManager against a real temporary state directory: atomic 0600
 * writes, the proper-lockfile session lock, refresh-token rotation across
 * concurrent callers and the rate-limit cooldown recorded by the HTTP
 * client while the lock is held.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { lock } from 'proper-lockfile';
import { RateLimitError } from '../errors/types';
import { SessionCredentials } from '../types/auth';
import { getActiveRateLimitCooldown, clearRateLimitCooldown } from './rate-limit';
import { CRYPTO_CACHE_TTL_MS, SessionManager } from './session';
import { CRYPTO_CACHE_FILE, SESSION_FILE, SESSION_LOCK_PATH, STATE_DIR } from './state-dir';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-session-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');

const mockFetch = jest.fn();
global.fetch = mockFetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SessionManager', () => {
  const hour = 60 * 60 * 1000;
  const mockSession: SessionCredentials = {
    sessionId: 'session123',
    uid: 'uid123',
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    scopes: ['full'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + hour,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.remove(STATE_DIR);
    await clearRateLimitCooldown();
  });

  afterAll(async () => {
    await fs.remove(os.homedir());
  });

  describe('session file', () => {
    it('writes session.json with owner-only permissions and without the mailbox password', async () => {
      await SessionManager.saveSession({ ...mockSession, mailboxPassword: 'secret' } as SessionCredentials);

      expect(SessionManager.getSessionFilePath()).toBe(SESSION_FILE);
      expect((await fs.stat(STATE_DIR)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(SESSION_FILE)).mode & 0o777).toBe(0o600);
      expect(await fs.readJson(SESSION_FILE)).toEqual(mockSession);
      expect(await SessionManager.loadSession()).toEqual(mockSession);
      expect(await fs.pathExists(SESSION_LOCK_PATH)).toBe(false);
    });

    it('returns null for a missing or malformed session file', async () => {
      expect(await SessionManager.loadSession()).toBeNull();

      await fs.ensureDir(STATE_DIR);
      await fs.writeJson(SESSION_FILE, { uid: 'only' });
      expect(await SessionManager.loadSession()).toBeNull();
    });

    it('clears the session file', async () => {
      await SessionManager.saveSession(mockSession);
      await SessionManager.clearSession();
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });
  });

  describe('local validity', () => {
    it('treats a session without known expiry as valid', async () => {
      const { tokenExpiresAt, ...opaque } = mockSession;
      await SessionManager.saveSession(opaque);
      expect(await SessionManager.hasValidSession()).toBe(true);
      expect(await SessionManager.validateSession(opaque)).toBe(true);
    });

    it('detects an expired token locally', async () => {
      const expired = { ...mockSession, tokenExpiresAt: Date.now() - 1000 };
      await SessionManager.saveSession(expired);
      expect(await SessionManager.hasValidSession()).toBe(false);
      expect(await SessionManager.validateSession(expired)).toBe(false);
    });

    it('has no valid session without a session file', async () => {
      expect(await SessionManager.hasValidSession()).toBe(false);
    });
  });

  describe('proactive token refresh', () => {
    it('does not refresh if the token is not expiring soon', async () => {
      await SessionManager.saveSession(mockSession);

      expect(await SessionManager.getValidSession()).toEqual(mockSession);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refreshes a token expiring within 5 minutes and stores the new expiry from ExpiresIn', async () => {
      await SessionManager.saveSession({ ...mockSession, tokenExpiresAt: Date.now() + 4 * 60 * 1000 });
      mockFetch.mockResolvedValue(jsonResponse(200, {
        AccessToken: 'new_access_token',
        RefreshToken: 'new_refresh_token',
        ExpiresIn: 3600,
      }));

      const before = Date.now();
      const result = await SessionManager.getValidSession();

      expect(result?.accessToken).toBe('new_access_token');
      expect(result?.refreshToken).toBe('new_refresh_token');
      expect(result?.tokenExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(await fs.readJson(SESSION_FILE)).toEqual(result);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://drive-api.proton.me/auth/v4/refresh');
      expect(init.headers['x-pm-uid']).toBe('uid123');
      expect(JSON.parse(init.body)).toMatchObject({ UID: 'uid123', RefreshToken: 'refresh_token' });
    });

    it('keeps the current session if the proactive refresh fails', async () => {
      const expiring = { ...mockSession, tokenExpiresAt: Date.now() + 4 * 60 * 1000 };
      await SessionManager.saveSession(expiring);
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      expect(await SessionManager.getValidSession()).toEqual(expiring);
    });

    it('leaves the expiry unknown when the refresh response carries no ExpiresIn', async () => {
      await SessionManager.saveSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2' }));

      const result = await SessionManager.refreshSession(mockSession);

      expect(result.tokenExpiresAt).toBeUndefined();
    });
  });

  describe('refresh-token rotation across processes', () => {
    it('returns tokens another process already rotated without consuming the refresh token', async () => {
      const rotated = { ...mockSession, accessToken: 'new_access_token', refreshToken: 'new_refresh_token' };
      await SessionManager.saveSession(rotated);

      const stale = { ...mockSession, accessToken: 'old_access_token', refreshToken: 'old_refresh_token' };
      expect(await SessionManager.refreshSession(stale)).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serialises concurrent refreshes: one API call, the other caller adopts the result', async () => {
      await SessionManager.saveSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2', ExpiresIn: 3600 }));

      const [first, second] = await Promise.all([
        SessionManager.refreshSession(mockSession),
        SessionManager.refreshSession(mockSession),
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first.accessToken).toBe('a2');
      expect(second).toEqual(first);
    });

    it('refuses to refresh a session that was logged out meanwhile', async () => {
      await expect(SessionManager.refreshSession(mockSession)).rejects.toThrow('No session to refresh');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });

    it('waits for the lock holder instead of failing immediately', async () => {
      await SessionManager.saveSession(mockSession);
      await fs.ensureDir(STATE_DIR);
      const release = await lock(SESSION_FILE, { lockfilePath: SESSION_LOCK_PATH, realpath: false });
      const save = SessionManager.saveSession({ ...mockSession, accessToken: 'after-lock' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await fs.readJson(SESSION_FILE)).accessToken).toBe('access_token');

      await release();
      await save;
      expect((await fs.readJson(SESSION_FILE)).accessToken).toBe('after-lock');
    });

    it('adopts rotated tokens when its own refresh is rejected', async () => {
      const stale = { ...mockSession, accessToken: 'old', refreshToken: 'old-refresh', tokenExpiresAt: Date.now() - 1 };
      await SessionManager.saveSession(stale);
      mockFetch.mockImplementation(async () => {
        // Another process rotates the tokens while this refresh is in flight.
        await fs.writeJson(SESSION_FILE, { ...mockSession, accessToken: 'rotated', refreshToken: 'rotated-refresh' });
        return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
      });

      const adopted = await SessionManager.refreshSessionOrAdoptRotated(stale);

      expect(adopted.accessToken).toBe('rotated');
    });

    it('propagates the refresh failure when nothing rotated the tokens', async () => {
      await SessionManager.saveSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' }));

      await expect(SessionManager.refreshSessionOrAdoptRotated(mockSession)).rejects.toThrow();
      expect((await fs.readJson(SESSION_FILE)).accessToken).toBe('access_token');
    });
  });

  describe('rate limiting during refresh', () => {
    it('records the cooldown and fails immediately when the refresh request is rate limited', async () => {
      await SessionManager.saveSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(429, { Code: 2028, Error: 'Too many requests' }, { 'retry-after': '45' }));

      const started = Date.now();
      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 45 });
      expect(Date.now() - started).toBeLessThan(1000);

      const cooldown = await getActiveRateLimitCooldown();
      expect(cooldown).toMatchObject({ retryAfter: 45, protonCode: 2028, message: 'Too many requests' });
      // The lock was released: the next session write proceeds at once.
      await SessionManager.saveSession(mockSession);
      // And every later request fails fast on the persisted cooldown.
      await expect(SessionManager.refreshSession(mockSession)).rejects.toBeInstanceOf(RateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('crypto-init cache', () => {
    const keySalts = [{ ID: 'k1', KeySalt: 'salt' }];
    const user = { ID: 'u1', Name: 'user', Email: 'user@proton.me', Keys: [] };
    const addresses = [{ ID: 'addr-1', Email: 'user@proton.me', Keys: [] }];

    it('round-trips through a 0600 file tied to the session UID', async () => {
      await SessionManager.saveSession(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, keySalts, user, addresses);

      expect((await fs.stat(CRYPTO_CACHE_FILE)).mode & 0o777).toBe(0o600);
      expect(await SessionManager.loadCryptoCache()).toMatchObject({ sessionUid: 'uid123', keySalts, user, addresses });
    });

    it('expires after CRYPTO_CACHE_TTL_MS so key rotations are picked up', async () => {
      await SessionManager.saveSession(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, keySalts, user, addresses);
      const { cachedAt } = await fs.readJson(CRYPTO_CACHE_FILE);

      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS - 1)).not.toBeNull();
      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS)).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('discards a cache that belongs to another session', async () => {
      await SessionManager.saveSession(mockSession);
      await SessionManager.saveCryptoCache('other-uid', keySalts, user, addresses);

      expect(await SessionManager.loadCryptoCache()).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });
  });
});
