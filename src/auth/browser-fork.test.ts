const mockReplaceSession = jest.fn();
const mockRemoveSecrets = jest.fn();
const mockGetSessionFilePath = jest.fn(() => '/tmp/proton-drive-cli/session.json');

jest.mock('./session', () => ({
  SessionManager: {
    replaceSession: mockReplaceSession,
    removeSecrets: mockRemoveSecrets,
    getSessionFilePath: mockGetSessionFilePath,
  },
}));
jest.mock('./session-secrets', () => jest.requireActual('../test/memory-session-secrets').mockSessionSecretsModule());
jest.mock('../utils/logger');

import { createCipheriv } from 'crypto';
import { HttpClientError } from '../api/http-client';
import { AppError, ErrorCode } from '../errors/types';
import type { SessionCredentials, SessionRecord } from '../types/auth';
import { memorySessionSecrets, MemorySessionSecrets } from '../test/memory-session-secrets';
import {
  BROWSER_FORK_INITIAL_DELAY_MS,
  BROWSER_FORK_MAX_POLL_TIME_MS,
  BROWSER_FORK_POLL_INTERVAL_MS,
  BrowserForkAuthService,
  generateBrowserForkSignInUrl,
  parseBrowserForkUserKeyPassword,
} from './browser-fork';

function encryptForkPayload(encryptionKey: Buffer, payload: Record<string, unknown> | string): string {
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from('fork', 'utf8'));

  const cipherText = Buffer.concat([
    cipher.update(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, cipherText, tag]).toString('base64');
}

function pendingForkError(): HttpClientError {
  return new HttpClientError('Authentication not ready', {
    response: {
      data: { Code: 2500, Error: 'Authentication not ready' },
      status: 422,
      headers: {},
      config: {},
    },
  });
}

describe('browser fork auth helpers', () => {
  it('generates the Proton account desktop login URL payload', () => {
    const encryptionKey = Buffer.alloc(32, 7);

    const result = generateBrowserForkSignInUrl(
      'external-drive',
      'user-code-123',
      encryptionKey
    );

    const url = new URL(result.signInUrl);
    const payload = decodeURIComponent(url.hash.replace('#payload=', ''));

    expect(url.origin).toBe('https://account.proton.me');
    expect(url.pathname).toBe('/desktop/login');
    expect(url.searchParams.get('app')).toBe('drive');
    expect(url.searchParams.get('pv')).toBe('3');
    expect(payload).toBe(`0:user-code-123:${encryptionKey.toString('base64')}:external-drive`);
  });

  it('decrypts the AES-GCM fork payload with Proton AAD', () => {
    const encryptionKey = Buffer.alloc(32, 9);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });

    expect(parseBrowserForkUserKeyPassword(encryptionKey, encryptedPayload))
      .toBe('derived-user-key-password');
  });
});

describe('BrowserForkAuthService payload errors', () => {
  it('reports an undecodable fork payload without quoting the decrypted bytes', async () => {
    const encryptionKey = Buffer.alloc(32, 10);
    const authApi = {
      logout: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn(),
      initSessionFork: jest.fn().mockResolvedValue({ Code: 1000, Selector: 'selector-123', UserCode: 'user-code-123' }),
      getSessionForkStatus: jest.fn().mockResolvedValue({
        Code: 1000,
        Payload: encryptForkPayload(encryptionKey, 'keyPassword=plaintext-secret'),
        UID: 'uid-123',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
      }),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    const error = await service.login({ initialDelayMs: 0 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: ErrorCode.AUTH_FAILED, message: 'Browser fork payload could not be decrypted' });
    expect(JSON.stringify(error)).not.toContain('plaintext');
    expect((error as AppError).toUserMessage()).not.toContain('keyPassword');
  });
});

/** Fork API answering `pending` times with 422, then approving `uid`. */
function forkApi(encryptionKey: Buffer, uid: string, pending = 0) {
  const getSessionForkStatus = jest.fn();
  for (let i = 0; i < pending; i++) {
    getSessionForkStatus.mockRejectedValueOnce(pendingForkError());
  }
  getSessionForkStatus.mockResolvedValue({
    Code: 1000,
    Payload: encryptForkPayload(encryptionKey, { keyPassword: 'derived-user-key-password' }),
    UID: uid,
    AccessToken: 'access-token',
    RefreshToken: 'refresh-token',
  });
  return {
    initSessionFork: jest.fn().mockResolvedValue({ Code: 1000, Selector: 'selector-123', UserCode: 'user-code-123' }),
    getSessionForkStatus,
    logout: jest.fn().mockResolvedValue(undefined),
    refreshToken: jest.fn(),
  };
}

const HOST = 'proton-drive-cli.invalid';

/** replaceSession of SessionManager: saves `session` under revision `rev-new`, replacing `previous`. */
function replacing(previous: SessionRecord | null) {
  return async (session: Omit<SessionCredentials, 'revision'>) => ({ session: { ...session, revision: 'rev-new' }, previous });
}

describe('BrowserForkAuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    memorySessionSecrets.reset();
    mockReplaceSession.mockImplementation(replacing(null));
    mockRemoveSecrets.mockResolvedValue(undefined);
  });

  it('polls until approval and saves the session with its tokens and key password', async () => {
    const encryptionKey = Buffer.alloc(32, 5);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    let now = 0;
    const sleepMs = jest.fn(async (ms: number) => {
      now += ms;
    });
    const authApi = {
      logout: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn(),
      initSessionFork: jest.fn().mockResolvedValue({
        Code: 1000,
        Selector: 'selector-123',
        UserCode: 'user-code-123',
      }),
      getSessionForkStatus: jest.fn()
        .mockRejectedValueOnce(pendingForkError())
        .mockResolvedValueOnce({
          Code: 1000,
          Payload: encryptedPayload,
          UID: 'uid-123',
          AccessToken: 'access-token',
          RefreshToken: 'refresh-token',
          Scopes: ['drive'],
          ExpiresIn: 120,
        }),
    };
    const onSignInUrl = jest.fn();
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs,
      now: () => now,
      encryptionKeyFactory: () => encryptionKey,
      appVersion: 'external-drive-protonlfscli@0.1.2',
      credentialStore: 'git-credential',
    });

    const result = await service.login({
      onSignInUrl,
      initialDelayMs: 10,
      pollIntervalMs: 20,
      maxPollTimeMs: 1_000,
    });

    expect(authApi.initSessionFork).toHaveBeenCalledTimes(1);
    expect(authApi.getSessionForkStatus).toHaveBeenCalledWith('selector-123');
    expect(authApi.getSessionForkStatus).toHaveBeenCalledTimes(2);
    expect(sleepMs).toHaveBeenNthCalledWith(1, 10);
    expect(sleepMs).toHaveBeenNthCalledWith(2, 20);
    expect(onSignInUrl).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(new URL(onSignInUrl.mock.calls[0][0]).hash))
      .toContain(`user-code-123:${encryptionKey.toString('base64')}:external-drive`);
    expect(mockReplaceSession).toHaveBeenCalledWith({
      uid: 'uid-123',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      keyPassword: 'derived-user-key-password',
      scopes: ['drive'],
      credentialStore: 'git-credential',
      credentialHost: HOST,
      tokenExpiresAt: expect.any(Number),
    });
    expect(result.session).toMatchObject({ uid: 'uid-123', revision: 'rev-new', keyPassword: 'derived-user-key-password' });
    expect(mockRemoveSecrets).not.toHaveBeenCalled();
  });

  it('saves to pass-cli at the default credential host unless told otherwise', async () => {
    const encryptionKey = Buffer.alloc(32, 16);
    const options = { authApi: forkApi(encryptionKey, 'uid-123'), sleepMs: jest.fn(async () => {}), encryptionKeyFactory: () => encryptionKey };

    await new BrowserForkAuthService(options).login({ initialDelayMs: 0 });
    await new BrowserForkAuthService({ ...options, credentialStore: 'git', credentialHost: 'other.invalid' }).login({ initialDelayMs: 0 });

    expect(mockReplaceSession.mock.calls.map(([session]) => [session.credentialStore, session.credentialHost])).toEqual([
      ['pass-cli', HOST],
      ['git-credential', 'other.invalid'],
    ]);
  });

  it('checks the chosen credential store before the session fork and the browser', async () => {
    const encryptionKey = Buffer.alloc(32, 17);
    const authApi = forkApi(encryptionKey, 'uid-123');
    const onSignInUrl = jest.fn();
    memorySessionSecrets.checkError = new Error('pass-cli is not logged in. Run: pass-cli login');

    const login = new BrowserForkAuthService({ authApi, sleepMs: jest.fn(async () => {}), encryptionKeyFactory: () => encryptionKey })
      .login({ initialDelayMs: 0, onSignInUrl });

    await expect(login).rejects.toMatchObject({
      code: ErrorCode.CREDENTIALS_UNAVAILABLE,
      message: 'The pass-cli credential store cannot save the session: pass-cli is not logged in. Run: pass-cli login',
      details: { credentialStore: 'pass-cli', credentialHost: HOST },
    });
    expect(memorySessionSecrets.checks).toEqual([`pass-cli|${HOST}`]);
    expect(authApi.initSessionFork).not.toHaveBeenCalled();
    expect(onSignInUrl).not.toHaveBeenCalled();
    expect(mockReplaceSession).not.toHaveBeenCalled();
  });

  it('checks the credential store once per login, then signs in', async () => {
    const encryptionKey = Buffer.alloc(32, 18);

    await new BrowserForkAuthService({
      authApi: forkApi(encryptionKey, 'uid-123'),
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
      credentialStore: 'git-credential',
    }).login({ initialDelayMs: 0 });

    expect(memorySessionSecrets.checks).toEqual([`git-credential|${HOST}`]);
    expect(mockReplaceSession).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported credential store before contacting Proton', () => {
    expect(() => new BrowserForkAuthService({ credentialStore: 'keychain' })).toThrow('Unsupported credential store: keychain');
  });

  it('follows the official session-fork polling schedule by default', async () => {
    expect(BROWSER_FORK_INITIAL_DELAY_MS).toBe(5_000);
    expect(BROWSER_FORK_POLL_INTERVAL_MS).toBe(5_000);
    expect(BROWSER_FORK_MAX_POLL_TIME_MS).toBe(600_000);

    const encryptionKey = Buffer.alloc(32, 13);
    const sleepMs = jest.fn(async (_ms: number) => {});
    const service = new BrowserForkAuthService({
      authApi: forkApi(encryptionKey, 'uid-123', 1),
      sleepMs,
      encryptionKeyFactory: () => encryptionKey,
    });

    await service.login();

    expect(sleepMs.mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000]);
  });

  it('removes the entry of the previous session and revokes it when the login yields another UID', async () => {
    const previous: SessionRecord = { uid: 'uid-old', credentialStore: 'pass-cli', credentialHost: 'old.invalid', revision: 'rev-old' };
    memorySessionSecrets.put('pass-cli', 'old.invalid', 'uid-old', { accessToken: 'old-access', refreshToken: 'old-refresh', keyPassword: 'old-key' }, 'rev-old');
    mockReplaceSession.mockImplementation(async (session: Omit<SessionCredentials, 'revision'>) => {
      expect(mockRemoveSecrets).not.toHaveBeenCalled();
      return replacing(previous)(session);
    });
    const encryptionKey = Buffer.alloc(32, 14);
    const authApi = forkApi(encryptionKey, 'uid-new');
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockReplaceSession).toHaveBeenCalledWith(expect.objectContaining({ uid: 'uid-new' }));
    expect(mockRemoveSecrets).toHaveBeenCalledWith(previous);
    expect(authApi.logout).toHaveBeenCalledWith('uid-old', 'old-access');
    expect(memorySessionSecrets.removes).toEqual([]);
  });

  it('removes the entry of the previous session without a revocation when the entry is unreadable', async () => {
    const previous: SessionRecord = { uid: 'uid-old', credentialStore: 'pass-cli', credentialHost: HOST, revision: 'rev-old' };
    mockReplaceSession.mockImplementation(replacing(previous));
    const encryptionKey = Buffer.alloc(32, 17);
    const authApi = forkApi(encryptionKey, 'uid-new');

    await new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    }).login({ initialDelayMs: 0 });

    expect(mockRemoveSecrets).toHaveBeenCalledWith(previous);
    expect(authApi.logout).not.toHaveBeenCalled();
  });

  it('keeps the entry when the login yields the previous session UID', async () => {
    mockReplaceSession.mockImplementation(replacing({ uid: 'uid-same', credentialStore: 'pass-cli', credentialHost: HOST, revision: 'r' }));
    const encryptionKey = Buffer.alloc(32, 15);
    const authApi = forkApi(encryptionKey, 'uid-same');
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockRemoveSecrets).not.toHaveBeenCalled();
    expect(authApi.logout).not.toHaveBeenCalled();
  });

  it('times out while Proton keeps reporting that the fork is pending', async () => {
    const encryptionKey = Buffer.alloc(32, 6);
    let now = 0;
    const sleepMs = jest.fn(async (ms: number) => {
      now += ms;
    });
    const authApi = {
      logout: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn(),
      initSessionFork: jest.fn().mockResolvedValue({
        Code: 1000,
        Selector: 'selector-123',
        UserCode: 'user-code-123',
      }),
      getSessionForkStatus: jest.fn().mockRejectedValue(pendingForkError()),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs,
      now: () => now,
      encryptionKeyFactory: () => encryptionKey,
    });

    await expect(service.login({
      initialDelayMs: 0,
      pollIntervalMs: 10,
      maxPollTimeMs: 15,
    })).rejects.toMatchObject({
      code: ErrorCode.AUTH_FAILED,
      message: 'Browser sign-in was not completed within 1 second',
      details: { maxPollTimeMs: 15 },
    });

    expect(authApi.getSessionForkStatus).toHaveBeenCalledTimes(2);
    expect(mockReplaceSession).not.toHaveBeenCalled();
  });

  it('polls the session fork at a fixed interval until the time budget ends', async () => {
    const encryptionKey = Buffer.alloc(32, 12);
    let now = 0;
    const sleepMs = jest.fn(async (ms: number) => {
      now += ms;
    });
    const authApi = {
      logout: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn(),
      initSessionFork: jest.fn().mockResolvedValue({
        Code: 1000,
        Selector: 'selector-123',
        UserCode: 'user-code-123',
      }),
      getSessionForkStatus: jest.fn().mockRejectedValue(pendingForkError()),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs,
      now: () => now,
      encryptionKeyFactory: () => encryptionKey,
    });

    await expect(service.login({
      initialDelayMs: 0,
      pollIntervalMs: 250,
      maxPollTimeMs: 700,
    })).rejects.toMatchObject({
      code: ErrorCode.AUTH_FAILED,
      message: 'Browser sign-in was not completed within 1 second',
    });

    expect(sleepMs.mock.calls.map(([ms]) => ms)).toEqual([0, 250, 250, 250]);
  });

  it('refuses to persist a fork session without a refresh token', async () => {
    const encryptionKey = Buffer.alloc(32, 8);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    const authApi = {
      logout: jest.fn().mockResolvedValue(undefined),
      refreshToken: jest.fn(),
      initSessionFork: jest.fn().mockResolvedValue({
        Code: 1000,
        Selector: 'selector-123',
        UserCode: 'user-code-123',
      }),
      getSessionForkStatus: jest.fn().mockResolvedValue({
        Code: 1000,
        Payload: encryptedPayload,
        UID: 'uid-123',
        AccessToken: 'access-token',
      }),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    await expect(service.login({ initialDelayMs: 0 }))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_FAILED });
    expect(mockReplaceSession).not.toHaveBeenCalled();
    expect(memorySessionSecrets.saves).toEqual([]);
  });

  it.each([
    ['the credential store does not save the session', () => new AppError(
      'The session could not be saved to pass-cli (did not read back as written). Fix the credential store',
      ErrorCode.CREDENTIALS_UNAVAILABLE,
      { credentialStore: 'pass-cli', credentialHost: HOST, storeError: 'did not read back as written' },
      true,
    )],
    ['session.json cannot be written', () => new Error('disk full')],
  ])('removes the new entry and revokes the forked session when %s', async (_label, failure) => {
    const encryptionKey = Buffer.alloc(32, 11);
    const error = failure();
    mockReplaceSession.mockRejectedValueOnce(error);
    const authApi = forkApi(encryptionKey, 'uid-123');
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    await expect(service.login({ initialDelayMs: 0 })).rejects.toBe(error);

    expect(memorySessionSecrets.removes).toEqual([MemorySessionSecrets.key('pass-cli', HOST, 'uid-123')]);
    expect(authApi.logout).toHaveBeenCalledWith('uid-123', 'access-token');
  });

  it('revokes the replaced session with the tokens of its entry, refreshing once on HTTP 401', async () => {
    const encryptionKey = Buffer.alloc(32, 12);
    const previous: SessionRecord = { uid: 'uid-old', scopes: [], credentialStore: 'pass-cli', credentialHost: HOST, revision: 'rev-old' };
    memorySessionSecrets.put('pass-cli', HOST, 'uid-old', { accessToken: 'old-access', refreshToken: 'old-refresh', keyPassword: 'old-key' }, 'rev-old');
    mockReplaceSession.mockImplementation(replacing(previous));
    const authApi = forkApi(encryptionKey, 'uid-123', 0);
    authApi.logout
      .mockRejectedValueOnce(new HttpClientError('Request failed with status 401', {
        response: { data: { Code: 401 }, status: 401, headers: {}, config: {} },
      }))
      .mockResolvedValueOnce(undefined);
    authApi.refreshToken.mockResolvedValueOnce({ UID: 'uid-old', AccessToken: 'old-access-2', RefreshToken: 'old-refresh-2' });
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockRemoveSecrets).toHaveBeenCalledWith(previous);
    expect(authApi.refreshToken).toHaveBeenCalledWith('uid-old', 'old-access', 'old-refresh');
    expect(authApi.logout).toHaveBeenLastCalledWith('uid-old', 'old-access-2');
  });
});
