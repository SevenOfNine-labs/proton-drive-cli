const mockCreateSDKClient = jest.fn();
const mockCredentialResolve = jest.fn();
const mockLoadSession = jest.fn();
const mockValidateSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockKeyPasswordVerify = jest.fn();
const mockNormalizeProviderName = jest.fn((name: string) => {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'git') return 'git-credential';
  if (normalized === 'pass') return 'pass-cli';
  if (['git-credential', 'pass-cli', 'stdin', 'interactive'].includes(normalized)) {
    return normalized;
  }
  throw new Error(`Unknown credential provider: ${name}`);
});

jest.mock('../sdk/client', () => ({
  createSDKClient: mockCreateSDKClient,
}));

jest.mock('../credentials', () => ({
  createProvider: jest.fn(() => ({
    resolve: mockCredentialResolve,
  })),
  normalizeProviderName: mockNormalizeProviderName,
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    loadSession: mockLoadSession,
    validateSession: mockValidateSession,
    refreshSession: mockRefreshSession,
  },
}));

jest.mock('../auth', () => ({
  AuthService: jest.fn(() => ({
    refreshSession: jest.fn(),
  })),
}));

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    provider: 'git-credential',
    host: 'proton-drive-key.proton-lfs-cli.local',
    verify: mockKeyPasswordVerify,
  })),
}));

import {
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
  errorToStatusCode,
  formatCaptchaError,
  getBridgeAuthState,
  getInitializedClient,
} from './bridge';
import { BridgeRequest } from '../bridge/validators';
import { BRIDGE_AUTH_STATES, BRIDGE_COMMANDS } from '../bridge/protocol';
import { createProvider } from '../credentials';
import { CaptchaError, ErrorCode } from '../errors/types';
import type { SessionCredentials } from '../types/auth';

const mockCreateProvider = createProvider as jest.MockedFunction<typeof createProvider>;
const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

function makeSession(overrides: Partial<SessionCredentials> = {}): SessionCredentials {
  return {
    sessionId: 'session-id',
    uid: 'session-uid',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['drive'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + 60_000,
    authMode: 'browser-fork',
    keyPasswordPersisted: true,
    keyPasswordProvider: 'git-credential',
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    ...overrides,
  };
}

function expectNoAuthStateNetworkOrCredentialSideEffects(): void {
  expect(mockRefreshSession).not.toHaveBeenCalled();
  expect(mockCredentialResolve).not.toHaveBeenCalled();
  expect(mockCreateProvider).not.toHaveBeenCalled();
  expect(mockCreateSDKClient).not.toHaveBeenCalled();
}

describe('bridge validators', () => {
  it('accepts valid OIDs and rejects malformed OIDs', () => {
    expect(() => validateOid(VALID_OID)).not.toThrow();
    expect(() => validateOid(VALID_OID.toUpperCase())).not.toThrow();
    expect(() => validateOid('g'.repeat(64))).toThrow('Invalid OID format');
    expect(() => validateOid('')).toThrow('OID is required');
  });

  it('rejects local path traversal', () => {
    expect(() => validateLocalPath('/tmp/file.txt')).not.toThrow();
    expect(() => validateLocalPath('../etc/passwd')).toThrow('Path traversal not allowed');
  });

  it('does not expose bridge auth or login-shaped request fields', () => {
    expect(BRIDGE_COMMANDS).not.toContain('auth');
    expect(BRIDGE_AUTH_STATES).not.toContain('login_available');

    expect(() => validateBridgeRequestForCommand('auth-state', {
      credentialProvider: 'git-credential',
    } as unknown as BridgeRequest)).toThrow('Unknown bridge request field "credentialProvider"');
    expect(() => validateBridgeRequestForCommand('auth-state', {
      allowLogin: false,
    } as unknown as BridgeRequest)).toThrow('Unknown bridge request field "allowLogin"');
    expect(() => validateBridgeRequestForCommand('auth-state', {
      username: 'user@proton.me',
    } as unknown as BridgeRequest)).toThrow('Unknown bridge request field "username"');
  });

  it('accepts data-password provider fields for transfer commands', () => {
    expect(() => validateBridgeRequestForCommand('init', {
      dataCredentialProvider: 'pass-cli',
      dataCredentialHost: 'proton-data.proton-lfs-cli.local',
      storageBase: 'LFS',
    })).not.toThrow();
  });

  it('maps structured auth errors to HTTP status codes', () => {
    expect(errorToStatusCode({ code: ErrorCode.KEY_PASSWORD_REQUIRED })).toBe(401);
    expect(errorToStatusCode({ code: ErrorCode.RATE_LIMITED })).toBe(429);
  });
});

describe('getBridgeAuthState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
    mockValidateSession.mockResolvedValue(false);
    mockKeyPasswordVerify.mockResolvedValue(true);
    mockCredentialResolve.mockResolvedValue({ username: 'data', password: 'data-password' });
    mockCreateSDKClient.mockResolvedValue({ ready: true });
  });

  it('reports needs_login without resolving credentials or contacting Proton', async () => {
    await expect(getBridgeAuthState({})).resolves.toMatchObject({
      state: 'needs_login',
      hasSession: false,
      willAttemptNetwork: false,
    });

    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports ready for a valid browser-fork session with key password present', async () => {
    mockLoadSession.mockResolvedValue(makeSession());
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);

    await expect(getBridgeAuthState({})).resolves.toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      keyPasswordAvailable: true,
      willAttemptNetwork: false,
    });

    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports ready for browser-fork two-password sessions with key password present', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ passwordMode: 2 }));
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);

    await expect(getBridgeAuthState({})).resolves.toMatchObject({
      state: 'ready',
      passwordMode: 2,
      authMode: 'browser-fork',
      keyPasswordAvailable: true,
      hasExplicitDataPassword: false,
      willAttemptNetwork: false,
    });

    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports needs_key_password when a browser-fork session cannot be unlocked', async () => {
    mockLoadSession.mockResolvedValue(makeSession());
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(false);

    await expect(getBridgeAuthState({})).resolves.toMatchObject({
      state: 'needs_key_password',
      keyPasswordAvailable: false,
    });
  });

  it.each([1, 2])('reports needs_data_password for legacy password mode %i sessions without data source', async (passwordMode) => {
    mockLoadSession.mockResolvedValue(makeSession({
      authMode: undefined,
      keyPasswordPersisted: undefined,
      keyPasswordProvider: undefined,
      keyPasswordHost: undefined,
      passwordMode,
    }));
    mockValidateSession.mockResolvedValue(true);

    await expect(getBridgeAuthState({})).resolves.toMatchObject({
      state: 'needs_data_password',
      passwordMode,
    });
  });

  it('reports configuration_error for invalid data provider names', async () => {
    mockLoadSession.mockResolvedValue(makeSession());
    mockValidateSession.mockResolvedValue(true);

    await expect(getBridgeAuthState({ dataCredentialProvider: 'mystery' })).resolves.toMatchObject({
      state: 'configuration_error',
      errors: ['Unknown credential provider: mystery'],
    });
  });
});

describe('getInitializedClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCredentialResolve.mockResolvedValue({ username: 'data', password: 'data-password' });
    mockCreateSDKClient.mockResolvedValue({ ready: true });
  });

  it('passes explicit data password and app version to the SDK client', async () => {
    await getInitializedClient({
      dataPassword: 'mailbox-password',
      appVersion: 'external-drive-root@9.9.9',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      dataPassword: 'mailbox-password',
      appVersion: 'external-drive-root@9.9.9',
    });
    expect(mockCreateProvider).not.toHaveBeenCalled();
  });

  it('resolves only the data-password provider before SDK initialization', async () => {
    await getInitializedClient({
      dataCredentialProvider: 'pass-cli',
      dataCredentialHost: 'proton-data.example.test',
    });

    expect(mockCreateProvider).toHaveBeenCalledWith('pass-cli', {
      host: 'proton-data.example.test',
    });
    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      dataPassword: 'data-password',
      appVersion: undefined,
    });
  });
});

describe('formatCaptchaError', () => {
  it('returns structured bridge CAPTCHA details without account login instructions', () => {
    const response = formatCaptchaError(new CaptchaError({
      captchaUrl: 'https://verify.proton.me',
      captchaToken: 'token',
      verificationMethods: ['captcha'],
    }));

    expect(response.ok).toBe(false);
    expect(response.code).toBe(407);
    expect(JSON.parse(response.details as string)).toMatchObject({
      captchaUrl: 'https://verify.proton.me',
      captchaToken: 'token',
      action: 'run: proton-drive login',
    });
  });
});
