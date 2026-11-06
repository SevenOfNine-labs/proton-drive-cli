/**
 * SessionManager against a real temporary state directory: 0600 writes, the proper-lockfile
 * session lock, refresh-token rotation across callers and the rate-limit cooldown during a refresh.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { lock } from 'proper-lockfile';
import { AppError, ErrorCode, RateLimitError } from '../errors/types';
import { SessionCredentials } from '../types/auth';
import type { Address, User } from '../types/crypto';
import { createKeyPasswordStore } from './key-password-store';
import { getActiveRateLimitCooldown, clearRateLimitCooldown } from './rate-limit';
import { CRYPTO_CACHE_TTL_MS, SessionManager, isSessionCredentials } from './session';
import { CRYPTO_CACHE_FILE, SESSION_FILE, SESSION_LOCK_PATH, STATE_DIR } from './state-dir';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-session-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');
const mockLockOptions: { onCompromised?: (error: Error) => void } = {};
jest.mock('proper-lockfile', () => {
  const actual = jest.requireActual('proper-lockfile');
  return {
    ...actual,
    lock: (file: string, options: { onCompromised?: (error: Error) => void }) => {
      mockLockOptions.onCompromised = options?.onCompromised;
      return actual.lock(file, options);
    },
  };
});
const mockKeyPasswordRemove = jest.fn();
jest.mock('./key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({ remove: mockKeyPasswordRemove })),
}));
const mockCreateKeyPasswordStore = createKeyPasswordStore as jest.MockedFunction<typeof createKeyPasswordStore>;

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
    uid: 'uid123',
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    scopes: ['full'],
    keyPasswordProvider: 'pass-cli',
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    tokenExpiresAt: Date.now() + hour,
  };

  const user = { ID: 'u1', Name: 'user', Email: 'user@proton.me', Keys: [] } as unknown as User;
  const addresses = [{ ID: 'addr-1', Email: 'user@proton.me', Keys: [] }] as unknown as Address[];

  beforeEach(async () => {
    jest.clearAllMocks();
    mockKeyPasswordRemove.mockResolvedValue(undefined);
    await fs.remove(STATE_DIR);
    await clearRateLimitCooldown();
  });

  afterAll(async () => {
    await fs.remove(os.homedir());
  });

  describe('session file', () => {
    it('writes session.json with owner-only permissions', async () => {
      await SessionManager.replaceSession(mockSession);

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

    it('classifies session.json as none, invalid or valid', async () => {
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'none' });

      await fs.ensureDir(STATE_DIR);
      await fs.writeFile(SESSION_FILE, '{not json');
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });

      await SessionManager.replaceSession(mockSession);
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'valid', session: mockSession });
    });

    it.each(['uid', 'accessToken', 'refreshToken', 'keyPasswordProvider', 'keyPasswordHost'])(
      'rejects a session file without %s, a field login writes',
      (field) => {
        const { [field as keyof SessionCredentials]: _omitted, ...partial } = mockSession;
        expect(isSessionCredentials(partial)).toBe(false);
        expect(isSessionCredentials({ ...mockSession, [field]: '' })).toBe(false);
      },
    );

    it('accepts a session without scopes or expiry', () => {
      const { scopes: _scopes, tokenExpiresAt: _expiry, ...minimal } = mockSession;
      expect(isSessionCredentials(minimal)).toBe(true);
    });

    it('reads a session whose provider is not git-credential or pass-cli as invalid', async () => {
      await fs.ensureDir(STATE_DIR);
      await fs.writeJson(SESSION_FILE, { ...mockSession, keyPasswordProvider: 'pass' });
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });
      await fs.writeJson(SESSION_FILE, { ...mockSession, keyPasswordProvider: 'stdin' });
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });
    });

    it('clears the session file', async () => {
      await SessionManager.replaceSession(mockSession);
      await SessionManager.clearSession();
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });
  });

  describe('local validity', () => {
    it('treats a session without known expiry as valid', async () => {
      const { tokenExpiresAt, ...opaque } = mockSession;
      await SessionManager.replaceSession(opaque);
      expect(await SessionManager.hasValidSession()).toBe(true);
      expect(await SessionManager.validateSession(opaque)).toBe(true);
    });

    it('detects an expired token locally', async () => {
      const expired = { ...mockSession, tokenExpiresAt: Date.now() - 1000 };
      await SessionManager.replaceSession(expired);
      expect(await SessionManager.hasValidSession()).toBe(false);
      expect(await SessionManager.validateSession(expired)).toBe(false);
    });

    it('has no valid session without a session file', async () => {
      expect(await SessionManager.hasValidSession()).toBe(false);
    });
  });

  describe('token refresh', () => {
    it('sends the official refresh request and stores the new expiry from ExpiresIn', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, {
        AccessToken: 'new_access_token',
        RefreshToken: 'new_refresh_token',
        ExpiresIn: 3600,
      }));

      const before = Date.now();
      const result = await SessionManager.refreshSession(mockSession);

      expect(result?.accessToken).toBe('new_access_token');
      expect(result?.refreshToken).toBe('new_refresh_token');
      expect(result?.tokenExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(await fs.readJson(SESSION_FILE)).toEqual(result);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://drive-api.proton.me/auth/v4/refresh');
      expect(init.headers['x-pm-uid']).toBe('uid123');
      expect(init.headers.Authorization).toBe('Bearer access_token');
      expect(JSON.parse(init.body)).toEqual({
        ResponseType: 'token',
        GrantType: 'refresh_token',
        RefreshToken: 'refresh_token',
      });
    });

    it('keeps the refresh token when the refresh response carries none', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', ExpiresIn: 3600 }));

      const result = await SessionManager.refreshSession(mockSession);

      expect(result).toMatchObject({ uid: 'uid123', accessToken: 'a2', refreshToken: 'refresh_token' });
      expect(await fs.readJson(SESSION_FILE)).toEqual(result);
    });

    it('leaves the expiry unknown when the refresh response carries no ExpiresIn', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2' }));

      const result = await SessionManager.refreshSession(mockSession);

      expect(result.tokenExpiresAt).toBeUndefined();
    });
  });

  describe('refresh-token rotation across processes', () => {
    it('returns tokens another process already rotated without consuming the refresh token', async () => {
      const rotated = { ...mockSession, accessToken: 'new_access_token', refreshToken: 'new_refresh_token' };
      await SessionManager.replaceSession(rotated);

      expect(await SessionManager.refreshSession({ uid: mockSession.uid, accessToken: 'old_access_token' })).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('serialises concurrent refreshes: one API call, the other caller adopts the result', async () => {
      await SessionManager.replaceSession(mockSession);
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
      await SessionManager.replaceSession(mockSession);
      await fs.ensureDir(STATE_DIR);
      const release = await lock(SESSION_FILE, { lockfilePath: SESSION_LOCK_PATH, realpath: false });
      const save = SessionManager.replaceSession({ ...mockSession, accessToken: 'after-lock' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await fs.readJson(SESSION_FILE)).accessToken).toBe('access_token');

      await release();
      await save;
      expect((await fs.readJson(SESSION_FILE)).accessToken).toBe('after-lock');
    });

    it('adopts tokens another process rotated after the lock was lost, instead of signing out', async () => {
      const stale = { ...mockSession, accessToken: 'old', refreshToken: 'old-refresh', tokenExpiresAt: Date.now() - 1 };
      await SessionManager.replaceSession(stale);
      mockFetch.mockImplementation(async () => {
        mockLockOptions.onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        await fs.writeJson(SESSION_FILE, { ...mockSession, accessToken: 'rotated', refreshToken: 'rotated-refresh' });
        return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
      });

      const adopted = await SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'old' });

      expect(adopted.accessToken).toBe('rotated');
      expect(await fs.readJson(SESSION_FILE)).toMatchObject({ refreshToken: 'rotated-refresh' });
      expect(mockKeyPasswordRemove).not.toHaveBeenCalled();
    });

    it('keeps the session when Proton rejects the refresh token after the lock was lost', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockImplementation(async () => {
        mockLockOptions.onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
      });

      const failure = await SessionManager.refreshSession(mockSession).catch((error: unknown) => error);

      expect(failure).toMatchObject({ details: { lockCompromised: true }, isRecoverable: false });
      expect(await fs.readJson(SESSION_FILE)).toEqual(mockSession);
      expect(mockKeyPasswordRemove).not.toHaveBeenCalled();
    });

    it('skips the refresh after a 401 when the session already carries another access token', async () => {
      const rotated = { ...mockSession, accessToken: 'rotated' };
      await SessionManager.replaceSession(rotated);

      expect(await SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'rejected' })).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([400, 401, 422])(
      'signs out when the refresh endpoint rejects the refresh token with HTTP %s',
      async (status) => {
        const session = { ...mockSession, accessToken: `access-${status}` };
        await SessionManager.replaceSession(session);
        await SessionManager.saveCryptoCache(session.uid, user, addresses);
        mockFetch.mockResolvedValue(jsonResponse(status, { Code: 10013, Error: 'Invalid refresh token' }));

        const failure = SessionManager.refreshSessionOrAdoptRotated(session);

        await expect(failure).rejects.toBeInstanceOf(AppError);
        await expect(failure).rejects.toMatchObject({
          code: ErrorCode.SESSION_EXPIRED,
          details: expect.objectContaining({ signedOut: true, statusCode: status, protonCode: 10013 }),
        });
        expect(await fs.pathExists(SESSION_FILE)).toBe(false);
        expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
        expect(mockCreateKeyPasswordStore).toHaveBeenCalledWith({
          provider: 'pass-cli',
          host: 'proton-drive-key.proton-lfs-cli.local',
        });
        expect(mockKeyPasswordRemove).toHaveBeenCalledWith('uid123');
      },
    );

    it.each([
      ['HTTP 408 with a Proton code', () => jsonResponse(408, { Code: 408, Error: 'Request timeout' })],
      ['an HTML 403 from a proxy', () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
      ['a 400 without a body', () => new Response(null, { status: 400 })],
    ])('keeps the session when the refresh fails with %s', async (_label, response) => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(response());

      await expect(SessionManager.refreshSession(mockSession)).rejects.not.toMatchObject({
        details: expect.objectContaining({ signedOut: true }),
      });
      expect(await fs.readJson(SESSION_FILE)).toEqual(mockSession);
      expect(mockKeyPasswordRemove).not.toHaveBeenCalled();
    });

    it('neither refreshes nor adopts a session file that holds another login', async () => {
      const other = { ...mockSession, uid: 'uid-other', accessToken: 'other-access' };
      await SessionManager.replaceSession(other);

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: ErrorCode.SESSION_EXPIRED });
      await expect(SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'replaced' })).rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await fs.readJson(SESSION_FILE)).toEqual(other);
    });

    it('signs out when the refresh response names another session UID', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { UID: 'uid-other', AccessToken: 'a2', RefreshToken: 'r2' }));

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
        details: expect.objectContaining({ signedOut: true }),
      });
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
      expect(mockKeyPasswordRemove).toHaveBeenCalledWith('uid123');
    });

    it('does not recreate a session that was removed while the refresh was in flight', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockImplementation(async () => {
        await fs.remove(SESSION_FILE);
        return jsonResponse(200, { AccessToken: 'late-access', RefreshToken: 'late-refresh', ExpiresIn: 3600 });
      });

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: ErrorCode.SESSION_EXPIRED });
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });

    it('keeps tokens another process wrote while the refresh was in flight', async () => {
      const rotated = { ...mockSession, accessToken: 'rotated', refreshToken: 'rotated-refresh' };
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockImplementation(async () => {
        await fs.writeJson(SESSION_FILE, rotated);
        return jsonResponse(200, { AccessToken: 'late-access', RefreshToken: 'late-refresh', ExpiresIn: 3600 });
      });

      await expect(SessionManager.refreshSession(mockSession)).resolves.toEqual(rotated);
      expect(await fs.readJson(SESSION_FILE)).toEqual(rotated);
    });

    it('saves a refresh Proton committed after the lock was lost, so the next refresh does not sign out', async () => {
      await SessionManager.replaceSession(mockSession);
      let serverRefreshToken = 'refresh_token';
      let generation = 1;
      let compromise = true;
      mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
        if (JSON.parse(init.body).RefreshToken !== serverRefreshToken) {
          return jsonResponse(422, { Code: 10013, Error: 'Invalid refresh token' });
        }
        generation += 1;
        serverRefreshToken = `refresh-${generation}`;
        if (compromise) {
          compromise = false;
          mockLockOptions.onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        }
        return jsonResponse(200, { AccessToken: `access-${generation}`, RefreshToken: serverRefreshToken, ExpiresIn: 3600 });
      });

      await expect(SessionManager.refreshSession(mockSession)).resolves.toMatchObject({ refreshToken: 'refresh-2' });
      await expect(SessionManager.refreshSession(mockSession)).resolves.toMatchObject({ accessToken: 'access-2' });
      expect(await fs.readJson(SESSION_FILE)).toMatchObject({ refreshToken: 'refresh-2' });
      expect(mockKeyPasswordRemove).not.toHaveBeenCalled();
    });

    it('keeps the session when the refresh fails with a server error or a network error', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValueOnce(jsonResponse(503, { Code: 503, Error: 'Unavailable' }));
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(SessionManager.refreshSession(mockSession)).rejects.not.toMatchObject({
        details: expect.objectContaining({ signedOut: true }),
      });
      await expect(SessionManager.refreshSession(mockSession)).rejects.toThrow();
      expect(await fs.readJson(SESSION_FILE)).toEqual(mockSession);
      expect(mockKeyPasswordRemove).not.toHaveBeenCalled();
    });

    it('shares one refresh among concurrent callers and lets the next caller retry a transient failure', async () => {
      const session = { ...mockSession, accessToken: 'shared-access' };
      await SessionManager.replaceSession(session);
      mockFetch.mockResolvedValue(jsonResponse(503, { Code: 503, Error: 'Unavailable' }));

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => SessionManager.refreshSessionOrAdoptRotated(session)),
      );
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await expect(SessionManager.refreshSessionOrAdoptRotated(session)).rejects.toBeInstanceOf(Error);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('reuses a rate-limited refresh failure instead of asking again', async () => {
      const session = { ...mockSession, accessToken: 'limited-access' };
      await SessionManager.replaceSession(session);
      mockFetch.mockResolvedValue(jsonResponse(429, { Code: 2028, Error: 'Too many requests' }));

      await expect(SessionManager.refreshSessionOrAdoptRotated(session)).rejects.toBeInstanceOf(Error);
      await expect(SessionManager.refreshSessionOrAdoptRotated(session)).rejects.toBeInstanceOf(Error);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await SessionManager.loadSession()).toMatchObject({ accessToken: 'limited-access' });
    });
  });

  describe('session removal', () => {
    it('removes session.json and the crypto cache of the ended session', async () => {
      await SessionManager.replaceSession(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);

      await expect(SessionManager.clearSession(mockSession.uid)).resolves.toBe(true);
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('keeps a session a new login wrote in place of the ended one', async () => {
      const next = { ...mockSession, uid: 'uid-next' };
      await SessionManager.replaceSession(next);

      await expect(SessionManager.clearSession(mockSession.uid)).resolves.toBe(false);
      await expect(SessionManager.clearInvalidSession()).resolves.toBe(false);
      expect(await fs.readJson(SESSION_FILE)).toEqual(next);
    });

    it('removes an invalid session file', async () => {
      await fs.ensureDir(STATE_DIR);
      await fs.writeJson(SESSION_FILE, { uid: 'only' });

      await expect(SessionManager.clearInvalidSession()).resolves.toBe(true);
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });
  });

  describe('login replacement', () => {
    it('returns the valid session it replaced', async () => {
      await SessionManager.replaceSession(mockSession);
      const next = { ...mockSession, uid: 'uid-next' };

      await expect(SessionManager.replaceSession(next)).resolves.toEqual(mockSession);
      await expect(SessionManager.replaceSession(next)).resolves.toEqual(next);
      expect(await fs.readJson(SESSION_FILE)).toEqual(next);
    });

    it('returns null when no valid session was replaced', async () => {
      await expect(SessionManager.replaceSession(mockSession)).resolves.toBeNull();
    });
  });

  describe('rate limiting during refresh', () => {
    it('records the cooldown and fails immediately when the refresh request is rate limited', async () => {
      await SessionManager.replaceSession(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(429, { Code: 2028, Error: 'Too many requests' }, { 'retry-after': '45' }));

      const started = Date.now();
      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 45 });
      expect(Date.now() - started).toBeLessThan(1000);

      const cooldown = await getActiveRateLimitCooldown();
      expect(cooldown).toMatchObject({ retryAfter: 45, protonCode: 2028, message: 'Too many requests' });
      // The lock was released: the next session write proceeds at once.
      await SessionManager.replaceSession(mockSession);
      // And every later request fails fast on the persisted cooldown.
      await expect(SessionManager.refreshSession(mockSession)).rejects.toBeInstanceOf(RateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await fs.readJson(SESSION_FILE)).toEqual(mockSession);
    });
  });

  describe('crypto-init cache', () => {
    it('round-trips through a 0600 file tied to the session UID', async () => {
      await SessionManager.replaceSession(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);

      expect((await fs.stat(CRYPTO_CACHE_FILE)).mode & 0o777).toBe(0o600);
      expect(await SessionManager.loadCryptoCache()).toMatchObject({ sessionUid: 'uid123', user, addresses });
    });

    it('expires after CRYPTO_CACHE_TTL_MS so key rotations are picked up', async () => {
      await SessionManager.replaceSession(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      const { cachedAt } = await fs.readJson(CRYPTO_CACHE_FILE);

      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS - 1)).not.toBeNull();
      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS)).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('does not save records fetched under a session that session.json does not hold', async () => {
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);

      await SessionManager.replaceSession({ ...mockSession, uid: 'uid-next' });
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('discards a cache that belongs to another session', async () => {
      await SessionManager.replaceSession(mockSession);
      await fs.writeJson(CRYPTO_CACHE_FILE, { sessionUid: 'other-uid', user, addresses, cachedAt: new Date().toISOString() });

      expect(await SessionManager.loadCryptoCache()).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });
  });
});
