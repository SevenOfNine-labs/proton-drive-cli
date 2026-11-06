const mockReplaceSession = jest.fn();
const mockRemoveKeyPassword = jest.fn();
const mockGetSessionFilePath = jest.fn(() => '/tmp/proton-drive-cli/session.json');
const mockKeyPasswordStore = {
  provider: 'git-credential' as const,
  host: 'proton-drive-key.proton-lfs-cli.local',
  store: jest.fn(),
  load: jest.fn(),
  remove: jest.fn(),
  verify: jest.fn(),
};

jest.mock('./session', () => ({
  SessionManager: {
    replaceSession: mockReplaceSession,
    removeKeyPassword: mockRemoveKeyPassword,
    getSessionFilePath: mockGetSessionFilePath,
  },
}));

import { createCipheriv } from 'crypto';
import { HttpClientError } from '../api/http-client';
import { ErrorCode } from '../errors/types';
import {
  BROWSER_FORK_INITIAL_DELAY_MS,
  BROWSER_FORK_MAX_POLL_TIME_MS,
  BROWSER_FORK_POLL_INTERVAL_MS,
  BrowserForkAuthService,
  generateBrowserForkSignInUrl,
  parseBrowserForkUserKeyPassword,
} from './browser-fork';

function encryptForkPayload(encryptionKey: Buffer, payload: Record<string, unknown>): string {
  const nonce = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from('fork', 'utf8'));

  const cipherText = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
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

describe('BrowserForkAuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKeyPasswordStore.store.mockResolvedValue(undefined);
    mockKeyPasswordStore.load.mockResolvedValue('derived-user-key-password');
    mockKeyPasswordStore.remove.mockResolvedValue(undefined);
    mockReplaceSession.mockResolvedValue(null);
    mockRemoveKeyPassword.mockResolvedValue(undefined);
  });

  it('polls until approval and saves a token-only browser-fork session', async () => {
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
      keyPasswordStore: mockKeyPasswordStore,
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
    expect(result.keyPasswordAvailable).toBe(true);
    expect(mockKeyPasswordStore.store).toHaveBeenCalledWith(
      'uid-123',
      'derived-user-key-password'
    );
    expect(mockKeyPasswordStore.load).toHaveBeenCalledWith('uid-123');
    expect(mockReplaceSession).toHaveBeenCalledWith({
      uid: 'uid-123',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scopes: ['drive'],
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
      tokenExpiresAt: expect.any(Number),
    });
    expect(mockRemoveKeyPassword).not.toHaveBeenCalled();
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
      keyPasswordStore: mockKeyPasswordStore,
    });

    await service.login();

    expect(sleepMs.mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000]);
  });

  it('removes the key password of the previous session when the login yields another UID', async () => {
    const previous = { uid: 'uid-old', keyPasswordProvider: 'pass-cli', keyPasswordHost: 'old-host' };
    mockReplaceSession.mockImplementation(async () => {
      expect(mockRemoveKeyPassword).not.toHaveBeenCalled();
      return previous;
    });
    const encryptionKey = Buffer.alloc(32, 14);
    const service = new BrowserForkAuthService({
      authApi: forkApi(encryptionKey, 'uid-new'),
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
      keyPasswordStore: mockKeyPasswordStore,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockReplaceSession).toHaveBeenCalledWith(expect.objectContaining({ uid: 'uid-new' }));
    expect(mockRemoveKeyPassword).toHaveBeenCalledWith(previous);
    expect(mockKeyPasswordStore.remove).not.toHaveBeenCalled();
  });

  it('keeps the key password when the login yields the previous session UID', async () => {
    mockReplaceSession.mockResolvedValue({ uid: 'uid-same', keyPasswordProvider: 'pass-cli', keyPasswordHost: 'h' });
    const encryptionKey = Buffer.alloc(32, 15);
    const service = new BrowserForkAuthService({
      authApi: forkApi(encryptionKey, 'uid-same'),
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
      keyPasswordStore: mockKeyPasswordStore,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockRemoveKeyPassword).not.toHaveBeenCalled();
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
      keyPasswordStore: mockKeyPasswordStore,
    });

    await expect(service.login({
      initialDelayMs: 0,
      pollIntervalMs: 10,
      maxPollTimeMs: 15,
    })).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
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
      keyPasswordStore: mockKeyPasswordStore,
    });

    await expect(service.login({
      initialDelayMs: 0,
      pollIntervalMs: 250,
      maxPollTimeMs: 700,
    })).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
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
      keyPasswordStore: mockKeyPasswordStore,
    });

    await expect(service.login({ initialDelayMs: 0 }))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_FAILED });
    expect(mockKeyPasswordStore.store).not.toHaveBeenCalled();
    expect(mockReplaceSession).not.toHaveBeenCalled();
  });

  it('does not save a session when key password readback verification fails', async () => {
    const encryptionKey = Buffer.alloc(32, 10);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    mockKeyPasswordStore.load.mockResolvedValue('another-key-password');
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
        RefreshToken: 'refresh-token',
      }),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
      keyPasswordStore: mockKeyPasswordStore,
    });

    await expect(service.login({ initialDelayMs: 0 }))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_FAILED });

    expect(mockKeyPasswordStore.store).toHaveBeenCalledWith(
      'uid-123',
      'derived-user-key-password'
    );
    expect(mockKeyPasswordStore.remove).toHaveBeenCalledWith('uid-123');
    expect(mockReplaceSession).not.toHaveBeenCalled();
    expect(authApi.logout).toHaveBeenCalledWith('uid-123', 'access-token');
  });

  it('rolls back the stored key password when saving the session fails', async () => {
    const encryptionKey = Buffer.alloc(32, 11);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    mockReplaceSession.mockRejectedValueOnce(new Error('disk full'));
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
        RefreshToken: 'refresh-token',
      }),
    };
    const service = new BrowserForkAuthService({
      authApi,
      sleepMs: jest.fn(async () => {}),
      encryptionKeyFactory: () => encryptionKey,
      keyPasswordStore: mockKeyPasswordStore,
    });

    await expect(service.login({ initialDelayMs: 0 }))
      .rejects.toThrow('disk full');

    expect(mockKeyPasswordStore.remove).toHaveBeenCalledWith('uid-123');
    expect(authApi.logout).toHaveBeenCalledWith('uid-123', 'access-token');
  });

  it('removes the key password of the replaced session and revokes it, refreshing once on HTTP 401', async () => {
    const encryptionKey = Buffer.alloc(32, 12);
    const previous = {
      uid: 'uid-old',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      scopes: [],
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    };
    mockReplaceSession.mockResolvedValueOnce(previous);
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
      keyPasswordStore: mockKeyPasswordStore,
    });

    await service.login({ initialDelayMs: 0 });

    expect(mockRemoveKeyPassword).toHaveBeenCalledWith(previous);
    expect(authApi.refreshToken).toHaveBeenCalledWith('uid-old', 'old-access', 'old-refresh');
    expect(authApi.logout).toHaveBeenLastCalledWith('uid-old', 'old-access-2');
  });
});
