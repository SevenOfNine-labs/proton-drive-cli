/**
 * SessionManager against a real temporary state directory and an in-memory
 * credential store: secret-free 0600 writes, the session lock, the revision
 * cache, refresh-token rotation and the rate-limit cooldown during a refresh.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { lock } from 'proper-lockfile';
import { AppError, ErrorCode, RateLimitError } from '../errors/types';
import type { SessionCredentials, SessionRecord } from '../types/auth';
import type { Address, User } from '../types/crypto';
import { memorySessionSecrets, MemorySessionSecrets } from '../test/memory-session-secrets';
import * as privateJsonFile from './private-json-file';
import { getActiveRateLimitCooldown, clearRateLimitCooldown } from './rate-limit';
import { CRYPTO_CACHE_TTL_MS, SessionManager, isSessionRecord } from './session';
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
jest.mock('./session-secrets', () => jest.requireActual('../test/memory-session-secrets').mockSessionSecretsModule());

const mockFetch = jest.fn();
global.fetch = mockFetch;

const HOST = 'proton-drive-cli.invalid';
const ENTRY = MemorySessionSecrets.key('pass-cli', HOST, 'uid123');

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** session.json as SessionManager writes it for `session`. */
function recordOf(session: SessionCredentials): SessionRecord {
  return {
    uid: session.uid,
    ...(session.scopes ? { scopes: session.scopes } : {}),
    credentialStore: session.credentialStore,
    credentialHost: session.credentialHost,
    revision: session.revision,
    ...(session.tokenExpiresAt !== undefined ? { tokenExpiresAt: session.tokenExpiresAt } : {}),
  };
}

let otherRevision = 0;

/** Write the entry and session.json of `session` as another process would, with a fresh revision. */
async function writeAsOtherProcess(session: Omit<SessionCredentials, 'revision'>): Promise<SessionCredentials> {
  otherRevision += 1;
  const written: SessionCredentials = { ...session, revision: `other-process-${otherRevision}` };
  memorySessionSecrets.put(session.credentialStore, session.credentialHost, session.uid, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    keyPassword: session.keyPassword,
  }, written.revision);
  await fs.ensureDir(STATE_DIR);
  await fs.writeJson(SESSION_FILE, recordOf(written));
  return written;
}

/** Store a refreshed entry that replaces session.json's revision, as a refresh stopped before session.json. */
async function writeAsOtherProcessWithoutSessionFile(): Promise<void> {
  const record = await fs.readJson(SESSION_FILE);
  memorySessionSecrets.put(record.credentialStore, record.credentialHost, record.uid, {
    accessToken: 'a2',
    refreshToken: 'r2',
    keyPassword: 'key_password',
  }, 'rev-interrupted', record.revision);
}

async function save(session: Omit<SessionCredentials, 'revision'>): Promise<SessionCredentials> {
  return (await SessionManager.replaceSession(session)).session;
}

describe('SessionManager', () => {
  const hour = 60 * 60 * 1000;
  const mockSession: Omit<SessionCredentials, 'revision'> = {
    uid: 'uid123',
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    keyPassword: 'key_password',
    scopes: ['full'],
    credentialStore: 'pass-cli',
    credentialHost: HOST,
    tokenExpiresAt: Date.now() + hour,
  };

  const user = { ID: 'u1', Name: 'user', Email: 'user@proton.me', Keys: [] } as unknown as User;
  const addresses = [{ ID: 'addr-1', Email: 'user@proton.me', Keys: [] }] as unknown as Address[];

  beforeEach(async () => {
    jest.clearAllMocks();
    memorySessionSecrets.reset();
    await fs.remove(STATE_DIR);
    await clearRateLimitCooldown();
  });

  afterAll(async () => {
    await fs.remove(os.homedir());
  });

  describe('session file', () => {
    it('writes session.json with owner-only permissions and without a secret', async () => {
      const saved = await save(mockSession);

      expect(SessionManager.getSessionFilePath()).toBe(SESSION_FILE);
      expect((await fs.stat(STATE_DIR)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(SESSION_FILE)).mode & 0o777).toBe(0o600);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
      const text = await fs.readFile(SESSION_FILE, 'utf8');
      for (const secret of ['access_token', 'refresh_token', 'key_password']) {
        expect(text).not.toContain(secret);
      }
      expect(saved.revision).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(memorySessionSecrets.entries.get(ENTRY)).toEqual({
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        keyPassword: 'key_password',
      });
      expect(await SessionManager.loadSession()).toEqual(saved);
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

      const saved = await save(mockSession);
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'valid', record: recordOf(saved) });
    });

    it('reads a session.json that carries tokens but no credential store or revision as invalid', async () => {
      await fs.ensureDir(STATE_DIR);
      await fs.writeJson(SESSION_FILE, {
        uid: 'uid123',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        keyPasswordProvider: 'pass-cli',
        keyPasswordHost: HOST,
      });

      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });
      expect(await SessionManager.loadSession()).toBeNull();
    });

    it('keeps only the session record fields of session.json', async () => {
      const written = await writeAsOtherProcess(mockSession);
      await fs.writeJson(SESSION_FILE, { ...recordOf(written), accessToken: 'stray' });

      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'valid', record: recordOf(written) });
    });

    it.each(['uid', 'credentialStore', 'credentialHost', 'revision'])(
      'rejects a session record without %s, a field login writes',
      (field) => {
        const record = { ...mockSession, revision: 'rev-1' };
        const { [field as keyof typeof record]: _omitted, ...partial } = record;
        expect(isSessionRecord(partial)).toBe(false);
        expect(isSessionRecord({ ...record, [field]: '' })).toBe(false);
      },
    );

    it('accepts a session record without scopes or expiry', () => {
      expect(isSessionRecord({ uid: 'u', credentialStore: 'git-credential', credentialHost: HOST, revision: 'r' })).toBe(true);
    });

    it('reads a session whose store is not git-credential or pass-cli as invalid', async () => {
      const written = await writeAsOtherProcess(mockSession);
      await fs.writeJson(SESSION_FILE, { ...recordOf(written), credentialStore: 'pass' });
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });
      await fs.writeJson(SESSION_FILE, { ...recordOf(written), credentialStore: 'stdin' });
      expect(await SessionManager.readStoredSession()).toEqual({ kind: 'invalid' });
    });

    it('clears the session file', async () => {
      await save(mockSession);
      await SessionManager.clearSession();
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });
  });

  describe('credential-store secrets', () => {
    it('reads the store once per revision and again for a revision another process wrote', async () => {
      await writeAsOtherProcess(mockSession);

      await SessionManager.loadSession();
      await SessionManager.loadSession();
      await SessionManager.loadSession();
      expect(memorySessionSecrets.loads).toEqual([ENTRY]);

      await writeAsOtherProcess({ ...mockSession, accessToken: 'access-2' });
      await expect(SessionManager.loadSession()).resolves.toMatchObject({ accessToken: 'access-2' });
      expect(memorySessionSecrets.loads).toEqual([ENTRY, ENTRY]);
    });

    it('needs no store read for the revision this process wrote', async () => {
      const saved = await save(mockSession);

      await expect(SessionManager.loadSession()).resolves.toEqual(saved);
      expect(memorySessionSecrets.loads).toEqual([]);
    });

    it('shares one store read among concurrent loads', async () => {
      await writeAsOtherProcess(mockSession);

      await Promise.all([SessionManager.loadSession(), SessionManager.loadSession(), SessionManager.loadSession()]);

      expect(memorySessionSecrets.loads).toEqual([ENTRY]);
    });

    it('caches an entry newer than session.json under its own revision until session.json names it', async () => {
      await writeAsOtherProcess(mockSession);
      memorySessionSecrets.put('pass-cli', HOST, 'uid123', {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        keyPassword: 'key_password',
      }, 'rev-newer');

      await expect(SessionManager.loadSession()).resolves.toMatchObject({ accessToken: 'access-2' });
      await SessionManager.loadSession();
      expect(memorySessionSecrets.loads).toEqual([ENTRY, ENTRY]);

      await fs.writeJson(SESSION_FILE, { ...(await fs.readJson(SESSION_FILE)), revision: 'rev-newer' });
      await expect(SessionManager.loadSession()).resolves.toMatchObject({ accessToken: 'access-2', revision: 'rev-newer' });
      expect(memorySessionSecrets.loads).toEqual([ENTRY, ENTRY]);
    });

    it('uses an entry of another revision for an unverified load', async () => {
      await writeAsOtherProcess(mockSession);
      memorySessionSecrets.revisions.set(ENTRY, 'rev-of-a-stale-item');

      await expect(SessionManager.loadSession()).resolves.toMatchObject({ accessToken: 'access_token' });
    });

    it('reports an unreadable store as CREDENTIALS_UNAVAILABLE and retries it on the next load', async () => {
      await writeAsOtherProcess(mockSession);
      memorySessionSecrets.loadError = new Error('pass-cli is not logged in');

      const failure = await SessionManager.loadSession().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: ErrorCode.CREDENTIALS_UNAVAILABLE,
        details: { credentialStore: 'pass-cli', credentialHost: HOST, storeError: 'pass-cli is not logged in' },
      });
      memorySessionSecrets.loadError = null;
      await expect(SessionManager.loadSession()).resolves.toMatchObject({ accessToken: 'access_token' });
      expect(memorySessionSecrets.loads).toEqual([ENTRY, ENTRY]);
    });

    it('writes no session.json when the store does not save the secrets, after four attempts', async () => {
      memorySessionSecrets.saveError = new Error('did not read back as written');

      await expect(SessionManager.replaceSession(mockSession)).rejects.toMatchObject({
        code: ErrorCode.CREDENTIALS_UNAVAILABLE,
        details: { credentialStore: 'pass-cli', storeError: 'did not read back as written' },
      });
      expect(memorySessionSecrets.saves).toEqual([ENTRY, ENTRY, ENTRY, ENTRY]);
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });

    it('saves a login entry that replaces no revision', async () => {
      const saved = await save(mockSession);

      expect(memorySessionSecrets.revisions.get(ENTRY)).toBe(saved.revision);
      expect(memorySessionSecrets.previousOf('pass-cli', HOST, 'uid123')).toBeUndefined();
    });
  });

  describe('local validity', () => {
    it('treats a session without known expiry as valid', async () => {
      const { tokenExpiresAt: _expiry, ...opaque } = mockSession;
      const saved = await save(opaque);
      expect(saved.tokenExpiresAt).toBeUndefined();
      expect(await SessionManager.hasValidSession()).toBe(true);
      expect(await SessionManager.validateSession(saved)).toBe(true);
    });

    it('detects an expired token locally', async () => {
      const expired = { ...mockSession, tokenExpiresAt: Date.now() - 1000 };
      await save(expired);
      expect(await SessionManager.hasValidSession()).toBe(false);
      expect(await SessionManager.validateSession(expired)).toBe(false);
    });

    it('has no valid session without a session file', async () => {
      expect(await SessionManager.hasValidSession()).toBe(false);
    });
  });

  describe('token refresh', () => {
    it('sends the official refresh request and stores the new tokens under a new revision', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, {
        AccessToken: 'new_access_token',
        RefreshToken: 'new_refresh_token',
        ExpiresIn: 3600,
      }));

      const before = Date.now();
      const result = await SessionManager.refreshSession(saved);

      expect(result.accessToken).toBe('new_access_token');
      expect(result.refreshToken).toBe('new_refresh_token');
      expect(result.keyPassword).toBe('key_password');
      expect(result.tokenExpiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(result.revision).not.toBe(saved.revision);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(result));
      expect(memorySessionSecrets.revisions.get(ENTRY)).toBe(result.revision);
      expect(memorySessionSecrets.previousOf('pass-cli', HOST, 'uid123')).toBe(saved.revision);
      expect(memorySessionSecrets.entries.get(ENTRY)).toEqual({
        accessToken: 'new_access_token',
        refreshToken: 'new_refresh_token',
        keyPassword: 'key_password',
      });
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

    it('reads the secrets from the store under the lock before refreshing', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2', ExpiresIn: 3600 }));
      const lockHeldAtLoad: boolean[] = [];
      memorySessionSecrets.onLoad = async () => {
        lockHeldAtLoad.push(await fs.pathExists(SESSION_LOCK_PATH));
      };

      await SessionManager.refreshSession(saved);

      expect(memorySessionSecrets.loads).toEqual([ENTRY]);
      expect(lockHeldAtLoad).toEqual([true]);
    });

    it('retries a store save that fails twice and keeps the refreshed tokens on the third attempt', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2', ExpiresIn: 3600 }));
      memorySessionSecrets.saves.length = 0;
      memorySessionSecrets.saveFailures.push(
        new Error('pass-cli item failed: 502 Bad Gateway'),
        new Error('pass-cli item failed: 503 Service Unavailable'),
      );

      const result = await SessionManager.refreshSession(saved);

      expect(memorySessionSecrets.saves).toEqual([ENTRY, ENTRY, ENTRY]);
      expect(result).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
      expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(result));
    });

    it('reports a session.json write failure after the store saved the refreshed tokens as that failure, not as a spent token', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2', ExpiresIn: 3600 }));
      const write = jest.spyOn(privateJsonFile, 'writePrivateJsonFile')
        .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      try {
        const failure = await SessionManager.refreshSession(saved).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('ENOSPC: no space left on device');
        expect((failure as Error).message).not.toContain('spent');
        expect(failure).not.toMatchObject({ code: ErrorCode.CREDENTIALS_UNAVAILABLE });
        expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
        expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
      } finally {
        write.mockRestore();
      }
    });

    it('refuses to spend the refresh token of an entry written with another revision than session.json', async () => {
      const saved = await save({ ...mockSession, tokenExpiresAt: Date.now() - 1_000 });
      memorySessionSecrets.revisions.set(ENTRY, 'rev-of-a-stale-item');

      const failure = await SessionManager.refreshSession(saved).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: ErrorCode.CREDENTIALS_UNAVAILABLE });
      expect((failure as AppError).message).toContain('entry does not belong to session.json');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(memorySessionSecrets.removes).toEqual([]);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
    });

    it('refuses an entry that replaces another revision than session.json holds', async () => {
      const saved = await save({ ...mockSession, tokenExpiresAt: Date.now() - 1_000 });
      memorySessionSecrets.put('pass-cli', HOST, 'uid123', {
        accessToken: 'a-old',
        refreshToken: 'r-old',
        keyPassword: 'key_password',
      }, 'rev-older', 'rev-oldest');

      const failure = await SessionManager.refreshSession(saved).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: ErrorCode.CREDENTIALS_UNAVAILABLE });
      expect((failure as AppError).message).toContain('entry does not belong to session.json');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
    });

    it('completes a refresh that stored the entry but not session.json, and adopts its tokens after a 401', async () => {
      const saved = await save(mockSession);
      memorySessionSecrets.put('pass-cli', HOST, 'uid123', {
        accessToken: 'a2',
        refreshToken: 'r2',
        keyPassword: 'key_password',
      }, 'rev-interrupted', saved.revision);

      const result = await SessionManager.refreshSession({ uid: 'uid123', accessToken: 'access_token' });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toMatchObject({ revision: 'rev-interrupted', accessToken: 'a2', refreshToken: 'r2' });
      expect(result.tokenExpiresAt).toBeUndefined();
      const { tokenExpiresAt: _expiry, ...completed } = recordOf(saved);
      expect(await fs.readJson(SESSION_FILE)).toEqual({ ...completed, revision: 'rev-interrupted' });
      expect(memorySessionSecrets.removes).toEqual([]);
      const { logger } = jest.requireMock('../utils/logger');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Completed a session write'));
    });

    it('completes an interrupted refresh and refreshes with the refresh token of its entry', async () => {
      await writeAsOtherProcess(mockSession);
      await writeAsOtherProcessWithoutSessionFile();
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a3', RefreshToken: 'r3', ExpiresIn: 3600 }));
      const stale = await SessionManager.loadSession();
      expect(stale).toMatchObject({ accessToken: 'a2' });

      const result = await SessionManager.refreshSession(stale!);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer a2');
      expect(JSON.parse(init.body).RefreshToken).toBe('r2');
      expect(result).toMatchObject({ accessToken: 'a3', refreshToken: 'r3' });
      expect(memorySessionSecrets.previousOf('pass-cli', HOST, 'uid123')).toBe('rev-interrupted');
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(result));
    });

    it('keeps the refresh token when the refresh response carries none', async () => {
      await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', ExpiresIn: 3600 }));

      const result = await SessionManager.refreshSession(mockSession);

      expect(result).toMatchObject({ uid: 'uid123', accessToken: 'a2', refreshToken: 'refresh_token' });
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(result));
    });

    it('leaves the expiry unknown when the refresh response carries no ExpiresIn', async () => {
      await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2' }));

      const result = await SessionManager.refreshSession(mockSession);

      expect(result.tokenExpiresAt).toBeUndefined();
    });

    it('reports CREDENTIALS_UNAVAILABLE when the refreshed tokens cannot be saved', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a2', RefreshToken: 'r2', ExpiresIn: 3600 }));
      memorySessionSecrets.saveError = new Error('git credential approve failed');
      memorySessionSecrets.saves.length = 0;

      const failure = await SessionManager.refreshSession(saved).catch((error: unknown) => error);

      expect(memorySessionSecrets.saves).toEqual([ENTRY, ENTRY, ENTRY, ENTRY]);
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: ErrorCode.CREDENTIALS_UNAVAILABLE,
        isRecoverable: false,
        message: 'The refreshed tokens could not be saved to pass-cli (git credential approve failed); the refresh ' +
          'token it held is spent. Fix the credential store; if the next command fails, run: proton-drive-cli login',
      });
      expect((failure as AppError).details).toEqual({
        credentialStore: 'pass-cli',
        credentialHost: HOST,
        storeError: 'git credential approve failed',
      });
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
    });
  });

  describe('refresh-token rotation across processes', () => {
    it('returns tokens another process already rotated without consuming the refresh token', async () => {
      const rotated = await save({ ...mockSession, accessToken: 'new_access_token', refreshToken: 'new_refresh_token' });

      expect(await SessionManager.refreshSession({ uid: mockSession.uid, accessToken: 'old_access_token' })).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('adopts a revision another process wrote without a store read under the lock, for tokens this process loaded', async () => {
      await save(mockSession);
      const rotated = await writeAsOtherProcess({ ...mockSession, accessToken: 'rotated_access', refreshToken: 'rotated_refresh' });
      const lockHeldAtLoad: boolean[] = [];
      memorySessionSecrets.onLoad = async () => {
        lockHeldAtLoad.push(await fs.pathExists(SESSION_LOCK_PATH));
      };

      const result = await SessionManager.refreshSession({ uid: mockSession.uid, accessToken: mockSession.accessToken });

      expect(result).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(lockHeldAtLoad).toEqual([false]);
    });

    it('adopts a revision another process wrote without a store read under the lock, for a caller that names its revision', async () => {
      const saved = await save(mockSession);
      const rotated = await writeAsOtherProcess({ ...mockSession, accessToken: 'rotated_access', refreshToken: 'rotated_refresh' });
      const lockHeldAtLoad: boolean[] = [];
      memorySessionSecrets.onLoad = async () => {
        lockHeldAtLoad.push(await fs.pathExists(SESSION_LOCK_PATH));
      };

      const result = await SessionManager.refreshSession({ uid: saved.uid, accessToken: 'unknown_access', revision: saved.revision });

      expect(result).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(lockHeldAtLoad).toEqual([false]);
    });

    it('refreshes once under the lock when the rotated session still carries the rejected access token', async () => {
      const current = await writeAsOtherProcess({ ...mockSession, accessToken: 'rejected_access', refreshToken: 'current_refresh' });
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a3', RefreshToken: 'r3', ExpiresIn: 3600 }));

      const result = await SessionManager.refreshSession({ uid: current.uid, accessToken: 'rejected_access', revision: 'older-revision' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).RefreshToken).toBe('current_refresh');
      expect(result).toMatchObject({ accessToken: 'a3', refreshToken: 'r3' });
      expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ accessToken: 'a3', refreshToken: 'r3' });
    });

    it('refreshes under the lock when the rotated revision is itself expired locally', async () => {
      const saved = await save(mockSession);
      await writeAsOtherProcess({ ...mockSession, accessToken: 'rotated_access', refreshToken: 'rotated_refresh', tokenExpiresAt: Date.now() - 1_000 });
      mockFetch.mockResolvedValue(jsonResponse(200, { AccessToken: 'a3', RefreshToken: 'r3', ExpiresIn: 3600 }));

      const result = await SessionManager.refreshSession({ uid: saved.uid, accessToken: saved.accessToken, revision: saved.revision });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).RefreshToken).toBe('rotated_refresh');
      expect(result).toMatchObject({ accessToken: 'a3', refreshToken: 'r3' });
    });

    it('serialises concurrent refreshes: one API call, the other caller adopts the result', async () => {
      await save(mockSession);
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
      const saved = await save(mockSession);
      await fs.ensureDir(STATE_DIR);
      const release = await lock(SESSION_FILE, { lockfilePath: SESSION_LOCK_PATH, realpath: false });
      const pending = SessionManager.replaceSession({ ...mockSession, accessToken: 'after-lock' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(memorySessionSecrets.entries.get(ENTRY)?.accessToken).toBe('access_token');
      expect((await fs.readJson(SESSION_FILE)).revision).toBe(saved.revision);

      await release();
      await pending;
      expect(memorySessionSecrets.entries.get(ENTRY)?.accessToken).toBe('after-lock');
      expect((await fs.readJson(SESSION_FILE)).revision).not.toBe(saved.revision);
    });

    it('adopts tokens another process rotated after the lock was lost, instead of signing out', async () => {
      await save({ ...mockSession, accessToken: 'old', refreshToken: 'old-refresh', tokenExpiresAt: Date.now() - 1 });
      mockFetch.mockImplementation(async () => {
        mockLockOptions.onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        await writeAsOtherProcess({ ...mockSession, accessToken: 'rotated', refreshToken: 'rotated-refresh' });
        return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
      });

      const adopted = await SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'old' });

      expect(adopted.accessToken).toBe('rotated');
      expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ refreshToken: 'rotated-refresh' });
      expect(memorySessionSecrets.removes).toEqual([]);
    });

    it('keeps the session when Proton rejects the refresh token after the lock was lost', async () => {
      const saved = await save(mockSession);
      mockFetch.mockImplementation(async () => {
        mockLockOptions.onCompromised?.(new Error('Unable to update lock within the stale threshold'));
        return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
      });

      const failure = await SessionManager.refreshSession(mockSession).catch((error: unknown) => error);

      expect(failure).toMatchObject({ details: { lockCompromised: true }, isRecoverable: false });
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
      expect(memorySessionSecrets.removes).toEqual([]);
    });

    it('skips the refresh after a 401 when the session already carries another access token', async () => {
      const rotated = await save({ ...mockSession, accessToken: 'rotated' });

      expect(await SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'rejected' })).toEqual(rotated);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([400, 401, 422])(
      'signs out when the refresh endpoint rejects the refresh token with HTTP %s',
      async (status) => {
        const session = await save({ ...mockSession, accessToken: `access-${status}` });
        await SessionManager.saveCryptoCache(session.uid, user, addresses);
        mockFetch.mockResolvedValue(jsonResponse(status, { Code: 10013, Error: 'Invalid refresh token' }));

        const failure = SessionManager.refreshSessionOrAdoptRotated(session);

        await expect(failure).rejects.toBeInstanceOf(AppError);
        await expect(failure).rejects.toMatchObject({
          code: ErrorCode.SESSION_EXPIRED,
          details: expect.objectContaining({ signedOut: true, credentialsRemoved: true, statusCode: status, protonCode: 10013 }),
        });
        expect(await fs.pathExists(SESSION_FILE)).toBe(false);
        expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
        expect(memorySessionSecrets.removes).toEqual([ENTRY]);
        expect(memorySessionSecrets.entries.has(ENTRY)).toBe(false);
        await expect(SessionManager.loadSession()).resolves.toBeNull();
      },
    );

    it('reports in the sign-out error that the credential store kept the entry', async () => {
      const session = await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' }));
      memorySessionSecrets.removeError = new Error('pass-cli is not logged in');

      await expect(SessionManager.refreshSession(session)).rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
        details: expect.objectContaining({ signedOut: true, credentialsRemoved: false }),
      });
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });

    it.each([
      ['HTTP 408 with a Proton code', () => jsonResponse(408, { Code: 408, Error: 'Request timeout' })],
      ['an HTML 403 from a proxy', () => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
      ['a 400 without a body', () => new Response(null, { status: 400 })],
    ])('keeps the session when the refresh fails with %s', async (_label, response) => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValue(response());

      await expect(SessionManager.refreshSession(mockSession)).rejects.not.toMatchObject({
        details: expect.objectContaining({ signedOut: true }),
      });
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
      expect(memorySessionSecrets.removes).toEqual([]);
    });

    it('neither refreshes nor adopts a session file that holds another login', async () => {
      const other = await save({ ...mockSession, uid: 'uid-other', accessToken: 'other-access' });

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: ErrorCode.SESSION_EXPIRED });
      await expect(SessionManager.refreshSessionOrAdoptRotated({ uid: mockSession.uid, accessToken: 'replaced' })).rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(other));
    });

    it('signs out when the refresh response names another session UID', async () => {
      await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(200, { UID: 'uid-other', AccessToken: 'a2', RefreshToken: 'r2' }));

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
        details: expect.objectContaining({ signedOut: true }),
      });
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
      expect(memorySessionSecrets.removes).toEqual([ENTRY]);
    });

    it('does not recreate a session that was removed while the refresh was in flight', async () => {
      await save(mockSession);
      mockFetch.mockImplementation(async () => {
        await fs.remove(SESSION_FILE);
        return jsonResponse(200, { AccessToken: 'late-access', RefreshToken: 'late-refresh', ExpiresIn: 3600 });
      });

      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: ErrorCode.SESSION_EXPIRED });
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
      expect(memorySessionSecrets.entries.get(ENTRY)?.accessToken).toBe('access_token');
    });

    it('keeps tokens another process wrote while the refresh was in flight', async () => {
      await save(mockSession);
      let rotated: SessionCredentials | undefined;
      mockFetch.mockImplementation(async () => {
        rotated = await writeAsOtherProcess({ ...mockSession, accessToken: 'rotated', refreshToken: 'rotated-refresh' });
        return jsonResponse(200, { AccessToken: 'late-access', RefreshToken: 'late-refresh', ExpiresIn: 3600 });
      });

      const result = await SessionManager.refreshSession(mockSession);

      expect(result).toEqual(rotated);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(rotated!));
      expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ accessToken: 'rotated', refreshToken: 'rotated-refresh' });
    });

    it('saves a refresh Proton committed after the lock was lost, so the next refresh does not sign out', async () => {
      await save(mockSession);
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
      expect(memorySessionSecrets.entries.get(ENTRY)).toMatchObject({ refreshToken: 'refresh-2' });
      expect(memorySessionSecrets.removes).toEqual([]);
    });

    it('keeps the session when the refresh fails with a server error or a network error', async () => {
      const saved = await save(mockSession);
      mockFetch.mockResolvedValueOnce(jsonResponse(503, { Code: 503, Error: 'Unavailable' }));
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(SessionManager.refreshSession(mockSession)).rejects.not.toMatchObject({
        details: expect.objectContaining({ signedOut: true }),
      });
      await expect(SessionManager.refreshSession(mockSession)).rejects.toThrow();
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
      expect(memorySessionSecrets.removes).toEqual([]);
    });

    it('shares one refresh among concurrent callers and lets the next caller retry a transient failure', async () => {
      const session = await save({ ...mockSession, accessToken: 'shared-access' });
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
      const session = await save({ ...mockSession, accessToken: 'limited-access' });
      mockFetch.mockResolvedValue(jsonResponse(429, { Code: 2028, Error: 'Too many requests' }));

      await expect(SessionManager.refreshSessionOrAdoptRotated(session)).rejects.toBeInstanceOf(Error);
      await expect(SessionManager.refreshSessionOrAdoptRotated(session)).rejects.toBeInstanceOf(Error);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await SessionManager.loadSession()).toMatchObject({ accessToken: 'limited-access' });
    });
  });

  describe('session removal', () => {
    it('removes session.json and the crypto cache of the ended session', async () => {
      await save(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);

      await expect(SessionManager.clearSession(mockSession.uid)).resolves.toBe(true);
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('keeps a session a new login wrote in place of the ended one', async () => {
      const next = await save({ ...mockSession, uid: 'uid-next' });

      await expect(SessionManager.clearSession(mockSession.uid)).resolves.toBe(false);
      await expect(SessionManager.clearInvalidSession()).resolves.toBe(false);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(next));
    });

    it('removes an invalid session file', async () => {
      await fs.ensureDir(STATE_DIR);
      await fs.writeJson(SESSION_FILE, { uid: 'only' });

      await expect(SessionManager.clearInvalidSession()).resolves.toBe(true);
      expect(await fs.pathExists(SESSION_FILE)).toBe(false);
    });

    it('removes the credential-store entry of a session record and logs a failure', async () => {
      const saved = await save(mockSession);
      await expect(SessionManager.removeSecrets(saved)).resolves.toBe(true);
      expect(memorySessionSecrets.entries.has(ENTRY)).toBe(false);

      memorySessionSecrets.removeError = new Error('pass-cli is not logged in');
      await expect(SessionManager.removeSecrets(saved)).resolves.toBe(false);
    });
  });

  describe('login replacement', () => {
    it('returns the valid session record it replaced', async () => {
      const first = await save(mockSession);
      const next = { ...mockSession, uid: 'uid-next' };

      const replaced = await SessionManager.replaceSession(next);
      expect(replaced.previous).toEqual(recordOf(first));
      const again = await SessionManager.replaceSession(next);
      expect(again.previous).toEqual(recordOf(replaced.session));
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(again.session));
    });

    it('returns no previous session when no valid session was replaced', async () => {
      await expect(SessionManager.replaceSession(mockSession)).resolves.toMatchObject({ previous: null });
    });
  });

  describe('rate limiting during refresh', () => {
    it('records the cooldown and fails immediately when the refresh request is rate limited', async () => {
      await save(mockSession);
      mockFetch.mockResolvedValue(jsonResponse(429, { Code: 2028, Error: 'Too many requests' }, { 'retry-after': '45' }));

      const started = Date.now();
      await expect(SessionManager.refreshSession(mockSession)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 45 });
      expect(Date.now() - started).toBeLessThan(1000);

      const cooldown = await getActiveRateLimitCooldown();
      expect(cooldown).toMatchObject({ retryAfter: 45, protonCode: 2028, message: 'Too many requests' });
      const saved = await save(mockSession);
      await expect(SessionManager.refreshSession(mockSession)).rejects.toBeInstanceOf(RateLimitError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(await fs.readJson(SESSION_FILE)).toEqual(recordOf(saved));
    });
  });

  describe('crypto-init cache', () => {
    it('round-trips through a 0600 file tied to the session UID', async () => {
      await save(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);

      expect((await fs.stat(CRYPTO_CACHE_FILE)).mode & 0o777).toBe(0o600);
      expect(await SessionManager.loadCryptoCache()).toMatchObject({ sessionUid: 'uid123', user, addresses });
    });

    it('expires after CRYPTO_CACHE_TTL_MS so key rotations are picked up', async () => {
      await save(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      const { cachedAt } = await fs.readJson(CRYPTO_CACHE_FILE);

      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS - 1)).not.toBeNull();
      expect(await SessionManager.loadCryptoCache(Date.parse(cachedAt) + CRYPTO_CACHE_TTL_MS)).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('does not save records fetched under a session that session.json does not hold', async () => {
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);

      await save({ ...mockSession, uid: 'uid-next' });
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('discards a cache that belongs to another session', async () => {
      await save(mockSession);
      await fs.writeJson(CRYPTO_CACHE_FILE, { sessionUid: 'other-uid', user, addresses, cachedAt: new Date().toISOString() });

      expect(await SessionManager.loadCryptoCache()).toBeNull();
      expect(await fs.pathExists(CRYPTO_CACHE_FILE)).toBe(false);
    });

    it('reads the crypto cache without a credential-store read', async () => {
      await writeAsOtherProcess(mockSession);
      await SessionManager.saveCryptoCache(mockSession.uid, user, addresses);

      expect(await SessionManager.loadCryptoCache()).not.toBeNull();
      expect(memorySessionSecrets.loads).toEqual([]);
    });
  });
});
