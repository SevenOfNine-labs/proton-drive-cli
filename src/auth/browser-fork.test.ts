const mockSaveSession = jest.fn();
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
    saveSession: mockSaveSession,
    getSessionFilePath: mockGetSessionFilePath,
  },
}));

import { createCipheriv } from 'crypto';
import { HttpClientError } from '../api/http-client';
import { ErrorCode } from '../errors/types';
import {
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

describe('BrowserForkAuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKeyPasswordStore.store.mockResolvedValue(undefined);
    mockKeyPasswordStore.verify.mockResolvedValue(true);
    mockKeyPasswordStore.remove.mockResolvedValue(undefined);
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
          PasswordMode: 1,
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
    expect(mockKeyPasswordStore.verify).toHaveBeenCalledWith('uid-123');
    expect(mockSaveSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'uid-123',
      uid: 'uid-123',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      scopes: ['drive'],
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    }));
  });

  it('times out while Proton keeps reporting that the fork is pending', async () => {
    const encryptionKey = Buffer.alloc(32, 6);
    let now = 0;
    const sleepMs = jest.fn(async (ms: number) => {
      now += ms;
    });
    const authApi = {
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
      details: { authMode: 'browser-fork' },
    });

    expect(authApi.getSessionForkStatus).toHaveBeenCalledTimes(2);
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('refuses to persist a fork session without a refresh token', async () => {
    const encryptionKey = Buffer.alloc(32, 8);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    const authApi = {
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
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('does not save a session when key password readback verification fails', async () => {
    const encryptionKey = Buffer.alloc(32, 10);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    mockKeyPasswordStore.verify.mockResolvedValue(false);
    const authApi = {
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
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('rolls back the stored key password when saving the session fails', async () => {
    const encryptionKey = Buffer.alloc(32, 11);
    const encryptedPayload = encryptForkPayload(encryptionKey, {
      keyPassword: 'derived-user-key-password',
    });
    mockSaveSession.mockRejectedValueOnce(new Error('disk full'));
    const authApi = {
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
  });
});
