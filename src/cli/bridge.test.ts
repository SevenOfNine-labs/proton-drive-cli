import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const mockCreateSDKClient = jest.fn();
const mockCredentialResolve = jest.fn();
const mockLoadSession = jest.fn();
const mockValidateSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockIsSessionForUser = jest.fn();
const mockKeyPasswordVerify = jest.fn();
const mockAuthServiceLogin = jest.fn();
const mockAuthServiceRefreshSession = jest.fn();
const mockNormalizeProviderName = jest.fn((name: string) => name);

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
    isSessionForUser: mockIsSessionForUser,
  },
}));

jest.mock('../auth', () => ({
  AuthService: jest.fn(() => ({
    login: mockAuthServiceLogin,
    refreshSession: mockAuthServiceRefreshSession,
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
  uploadFileWithRetry,
  downloadFileWithRetry,
} from './bridge';
import { BridgeRequest } from '../bridge/validators';
import { createProvider } from '../credentials';
import { ErrorCode, CaptchaError } from '../errors/types';
import type { SessionCredentials } from '../types/auth';
import { createRetryConfig } from '../utils/retry';

const mockCreateProvider = createProvider as jest.MockedFunction<typeof createProvider>;

function makeSession(overrides: Partial<SessionCredentials> = {}): SessionCredentials {
  return {
    sessionId: 'session-id',
    uid: 'session-uid',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['drive'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function expectNoAuthStateNetworkOrCredentialSideEffects(): void {
  expect(mockAuthServiceLogin).not.toHaveBeenCalled();
  expect(mockAuthServiceRefreshSession).not.toHaveBeenCalled();
  expect(mockRefreshSession).not.toHaveBeenCalled();
  expect(mockIsSessionForUser).not.toHaveBeenCalled();
  expect(mockCredentialResolve).not.toHaveBeenCalled();
  expect(mockCreateProvider).not.toHaveBeenCalled();
  expect(mockCreateSDKClient).not.toHaveBeenCalled();
}

describe('validateOid', () => {
  const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

  it('accepts valid 64-char hex OID', () => {
    expect(() => validateOid(VALID_OID)).not.toThrow();
  });

  it('accepts uppercase hex OID', () => {
    expect(() => validateOid(VALID_OID.toUpperCase())).not.toThrow();
  });

  it('rejects 63-char OID', () => {
    expect(() => validateOid(VALID_OID.slice(0, 63))).toThrow('Invalid OID format');
  });

  it('rejects 65-char OID', () => {
    expect(() => validateOid(VALID_OID + 'a')).toThrow('Invalid OID format');
  });

  it('rejects non-hex characters', () => {
    const nonHex = 'g'.repeat(64);
    expect(() => validateOid(nonHex)).toThrow('Invalid OID format');
  });

  it('rejects empty string', () => {
    expect(() => validateOid('')).toThrow('OID is required');
  });

  it('rejects null/undefined', () => {
    expect(() => validateOid(null as any)).toThrow('OID is required');
    expect(() => validateOid(undefined as any)).toThrow('OID is required');
  });
});

describe('validateLocalPath', () => {
  it('accepts a valid absolute path', () => {
    expect(() => validateLocalPath('/tmp/file.txt')).not.toThrow();
  });

  it('accepts a valid relative path', () => {
    expect(() => validateLocalPath('file.txt')).not.toThrow();
  });

  it('rejects path with .. traversal', () => {
    expect(() => validateLocalPath('../etc/passwd')).toThrow('Path traversal not allowed');
  });

  it('rejects absolute path with .. traversal', () => {
    expect(() => validateLocalPath('/tmp/../etc/passwd')).toThrow('Path traversal not allowed');
  });

  it('rejects empty string', () => {
    expect(() => validateLocalPath('')).toThrow('File path is required');
  });

  it('rejects null/undefined', () => {
    expect(() => validateLocalPath(null as any)).toThrow('File path is required');
    expect(() => validateLocalPath(undefined as any)).toThrow('File path is required');
  });
});

describe('validateBridgeRequestForCommand', () => {
  const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

  it('accepts upload request fields used by the Go adapter', () => {
    expect(() => validateBridgeRequestForCommand('upload', {
      oid: VALID_OID,
      path: '/tmp/object.bin',
      storageBase: 'LFS',
      credentialProvider: 'git-credential',
      appVersion: 'proton-lfs-cli-test',
      allowLogin: false,
    })).not.toThrow();
  });

  it('rejects missing command-required fields', () => {
    expect(() => validateBridgeRequestForCommand('upload', {
      oid: VALID_OID,
    })).toThrow('Field "path" is required for bridge upload');
  });

  it('rejects fields that belong to another command', () => {
    expect(() => validateBridgeRequestForCommand('upload', {
      oid: VALID_OID,
      path: '/tmp/object.bin',
      outputPath: '/tmp/out.bin',
    })).toThrow('Field "outputPath" is not allowed for bridge upload');
  });

  it('keeps auth-state local by rejecting transfer fields', () => {
    expect(() => validateBridgeRequestForCommand('auth-state', {
      storageBase: 'LFS',
      credentialProvider: 'git-credential',
      oid: VALID_OID,
    })).toThrow('Field "oid" is not allowed for bridge auth-state');
  });

  it('accepts auth-state readiness selectors used by the Go adapter', () => {
    expect(() => validateBridgeRequestForCommand('auth-state', {
      storageBase: 'LFS',
      credentialProvider: 'git-credential',
      dataCredentialProvider: 'git-credential',
      dataCredentialHost: 'proton-data.proton-lfs-cli.local',
      appVersion: 'proton-lfs-cli-test',
    })).not.toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => validateBridgeRequestForCommand('auth-state', {
      unknown: 'field',
    })).toThrow('Unknown bridge request field "unknown"');
  });

  it('rejects non-object requests', () => {
    expect(() => validateBridgeRequestForCommand('auth-state', null)).toThrow(
      'Bridge request must be a JSON object'
    );
  });

  it('rejects invalid field types before command handlers run', () => {
    expect(() => validateBridgeRequestForCommand('batch-exists', {
      oids: VALID_OID,
    })).toThrow('Field "oids" must be an array of strings');
    expect(() => validateBridgeRequestForCommand('upload', {
      oid: VALID_OID,
      path: '/tmp/object.bin',
      allowLogin: 'false',
    })).toThrow('Field "allowLogin" must be a boolean');
  });
});

describe('errorToStatusCode', () => {
  it('maps AUTH_FAILED to 401', () => {
    expect(errorToStatusCode({ code: ErrorCode.AUTH_FAILED })).toBe(401);
  });

  it('maps SESSION_EXPIRED to 401', () => {
    expect(errorToStatusCode({ code: ErrorCode.SESSION_EXPIRED })).toBe(401);
  });

  it('maps NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.NOT_FOUND })).toBe(404);
  });

  it('maps PATH_NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.PATH_NOT_FOUND })).toBe(404);
  });

  it('maps FILE_NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.FILE_NOT_FOUND })).toBe(404);
  });

  it('maps FILE_TOO_LARGE to 413', () => {
    expect(errorToStatusCode({ code: ErrorCode.FILE_TOO_LARGE })).toBe(413);
  });

  it('maps RATE_LIMITED to 429', () => {
    expect(errorToStatusCode({ code: ErrorCode.RATE_LIMITED })).toBe(429);
  });

  it('maps TIMEOUT to 504', () => {
    expect(errorToStatusCode({ code: ErrorCode.TIMEOUT })).toBe(504);
  });

  it('maps OPERATION_CANCELLED to 499', () => {
    expect(errorToStatusCode({ code: ErrorCode.OPERATION_CANCELLED })).toBe(499);
  });

  it('falls back to 500 for unknown error codes', () => {
    expect(errorToStatusCode({ code: 'SOMETHING_WEIRD' })).toBe(500);
  });

  it('falls back to message-based matching for "not found"', () => {
    expect(errorToStatusCode({ message: 'Resource not found' })).toBe(404);
  });

  it('falls back to message-based matching for "unauthorized"', () => {
    expect(errorToStatusCode({ message: 'Unauthorized request' })).toBe(401);
  });

  it('falls back to message-based matching for "invalid"', () => {
    expect(errorToStatusCode({ message: 'Invalid input provided' })).toBe(400);
  });

  it('maps CAPTCHA_REQUIRED to 407', () => {
    expect(errorToStatusCode({ code: ErrorCode.CAPTCHA_REQUIRED })).toBe(407);
  });

  it('maps KEY_PASSWORD_REQUIRED to 401', () => {
    expect(errorToStatusCode({ code: ErrorCode.KEY_PASSWORD_REQUIRED })).toBe(401);
  });

  it('falls back to message-based matching for "captcha"', () => {
    expect(errorToStatusCode({ message: 'CAPTCHA verification required' })).toBe(407);
  });

  it('returns 500 for null/undefined error', () => {
    expect(errorToStatusCode(null)).toBe(500);
    expect(errorToStatusCode(undefined)).toBe(500);
  });
});

describe('BridgeRequest credentialProvider field', () => {
  it('accepts credentialProvider in the request type', () => {
    const request: BridgeRequest = {
      credentialProvider: 'git-credential',
    };
    expect(request.credentialProvider).toBe('git-credential');
  });

  it('is optional (backward compatible)', () => {
    const request: BridgeRequest = {
      username: 'user@proton.me',
      password: 'secret',
    };
    expect(request.credentialProvider).toBeUndefined();
  });

  it('can coexist with username/password', () => {
    const request: BridgeRequest = {
      username: 'user@proton.me',
      password: 'secret',
      credentialProvider: 'git-credential',
    };
    expect(request.username).toBe('user@proton.me');
    expect(request.credentialProvider).toBe('git-credential');
  });

  it('accepts explicit allowLogin control for transfer callers', () => {
    const request: BridgeRequest = {
      credentialProvider: 'git-credential',
      allowLogin: false,
    };
    expect(request.allowLogin).toBe(false);
  });
});

describe('getBridgeAuthState', () => {
  beforeEach(() => {
    mockCreateSDKClient.mockReset();
    mockCredentialResolve.mockReset();
    mockCreateProvider.mockClear();
    mockNormalizeProviderName.mockReset();
    mockNormalizeProviderName.mockImplementation((name: string) => name);
    mockLoadSession.mockReset();
    mockValidateSession.mockReset();
    mockRefreshSession.mockReset();
    mockKeyPasswordVerify.mockReset();
    mockIsSessionForUser.mockReset();
    mockAuthServiceLogin.mockReset();
    mockAuthServiceRefreshSession.mockReset();
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);
  });

  it('reports missing login without resolving credentials or creating a client', async () => {
    mockLoadSession.mockResolvedValue(null);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'needs_login',
      hasSession: false,
      sessionValid: false,
      allowLogin: false,
      willAttemptNetwork: false,
    });
    expect(state.actions[0]).toContain('login');
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('keeps auth-state side-effect free across local readiness outcomes', async () => {
    const cases: Array<{
      name: string;
      request: BridgeRequest;
      session: SessionCredentials | null;
      sessionValid?: boolean;
      wantState: string;
    }> = [
      {
        name: 'missing session with provider-backed login available',
        request: { credentialProvider: 'git-credential' },
        session: null,
        wantState: 'login_available',
      },
      {
        name: 'ready single-password session',
        request: {},
        session: makeSession({ passwordMode: 1 }),
        sessionValid: true,
        wantState: 'ready',
      },
      {
        name: 'two-password session missing data password source',
        request: {},
        session: makeSession({ passwordMode: 2 }),
        sessionValid: true,
        wantState: 'needs_data_password',
      },
      {
        name: 'browser-fork session missing key password source',
        request: {},
        session: makeSession({
          passwordMode: 1,
          authMode: 'browser-fork',
          keyPasswordPersisted: false,
        }),
        sessionValid: true,
        wantState: 'needs_key_password',
      },
      {
        name: 'expired session',
        request: {},
        session: makeSession({ tokenExpiresAt: Date.now() - 1_000 }),
        sessionValid: false,
        wantState: 'session_expired',
      },
      {
        name: 'locally invalid session',
        request: {},
        session: makeSession({ tokenExpiresAt: Date.now() + 60_000 }),
        sessionValid: false,
        wantState: 'session_invalid',
      },
    ];

    for (const tc of cases) {
      mockCreateSDKClient.mockClear();
      mockCredentialResolve.mockClear();
      mockCreateProvider.mockClear();
      mockLoadSession.mockReset();
      mockValidateSession.mockReset();
      mockRefreshSession.mockClear();
      mockIsSessionForUser.mockClear();
      mockAuthServiceLogin.mockClear();
      mockAuthServiceRefreshSession.mockClear();
      mockKeyPasswordVerify.mockClear();
      mockLoadSession.mockResolvedValue(tc.session);
      mockValidateSession.mockResolvedValue(tc.sessionValid ?? true);

      const state = await getBridgeAuthState(tc.request);

      expect(state.state).toBe(tc.wantState);
      expect(state.willAttemptNetwork).toBe(false);
      if (tc.session) {
        expect(mockValidateSession).toHaveBeenCalledWith(tc.session, false);
      } else {
        expect(mockValidateSession).not.toHaveBeenCalled();
      }
      expectNoAuthStateNetworkOrCredentialSideEffects();
    }
  });

  it('does not resolve credentials or contact Proton for invalid provider config', async () => {
    mockNormalizeProviderName.mockImplementation(() => {
      throw new Error('Unknown credential provider: mystery');
    });
    mockLoadSession.mockResolvedValue(null);

    const state = await getBridgeAuthState({
      credentialProvider: 'mystery',
    });

    expect(state).toMatchObject({
      state: 'configuration_error',
      willAttemptNetwork: false,
    });
    expect(mockValidateSession).not.toHaveBeenCalled();
    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports login availability for provider-backed login without resolving the provider', async () => {
    mockLoadSession.mockResolvedValue(null);

    const state = await getBridgeAuthState({
      credentialProvider: 'git-credential',
    });

    expect(state).toMatchObject({
      state: 'login_available',
      hasSession: false,
      sessionValid: false,
      loginCredentialProvider: 'git-credential',
      allowLogin: true,
      willAttemptNetwork: false,
    });
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('reports a valid single-password session as ready', async () => {
    const session = makeSession({ passwordMode: 1 });
    mockLoadSession.mockResolvedValue(session);
    mockValidateSession.mockResolvedValue(true);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      sessionUidPresent: true,
      passwordMode: 1,
      willAttemptNetwork: false,
    });
    expect(mockValidateSession).toHaveBeenCalledWith(session, false);
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('requires a mailbox/data password source for valid two-password sessions', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ passwordMode: 2 }));
    mockValidateSession.mockResolvedValue(true);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'needs_data_password',
      hasSession: true,
      sessionValid: true,
      passwordMode: 2,
      hasExplicitDataPassword: false,
      dataCredentialProvider: undefined,
      willAttemptNetwork: false,
    });
    expect(state.actions[0]).toContain('mailbox/data password');
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('requires a key password source for browser-fork sessions without persisted key passwords', async () => {
    mockLoadSession.mockResolvedValue(makeSession({
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: false,
    }));
    mockValidateSession.mockResolvedValue(true);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'needs_key_password',
      hasSession: true,
      sessionValid: true,
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: false,
      keyPasswordAvailable: false,
      hasExplicitDataPassword: false,
      willAttemptNetwork: false,
    });
    expect(state.actions[0]).toContain('stored key password');
    expect(mockKeyPasswordVerify).not.toHaveBeenCalled();
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('reports ready for browser-fork sessions with readable stored key passwords', async () => {
    mockLoadSession.mockResolvedValue(makeSession({
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    }));
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordAvailable: true,
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
      willAttemptNetwork: false,
    });
    expect(mockKeyPasswordVerify).toHaveBeenCalledWith('session-uid');
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('requires key password recovery when a persisted browser-fork secret is unreadable', async () => {
    mockLoadSession.mockResolvedValue(makeSession({
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    }));
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(false);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'needs_key_password',
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordAvailable: false,
      willAttemptNetwork: false,
    });
    expect(mockKeyPasswordVerify).toHaveBeenCalledWith('session-uid');
  });

  it('accepts a data password source for browser-fork sessions', async () => {
    mockLoadSession.mockResolvedValue(makeSession({
      passwordMode: 1,
      authMode: 'browser-fork',
      keyPasswordPersisted: false,
    }));
    mockValidateSession.mockResolvedValue(true);

    const state = await getBridgeAuthState({
      dataCredentialProvider: 'git-credential',
    });

    expect(state).toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      passwordMode: 1,
      authMode: 'browser-fork',
      dataCredentialProvider: 'git-credential',
      dataCredentialHost: 'proton-data.proton-lfs-cli.local',
      willAttemptNetwork: false,
    });
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('accepts a provider-backed data password source without resolving it', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ passwordMode: 2 }));
    mockValidateSession.mockResolvedValue(true);

    const state = await getBridgeAuthState({
      dataCredentialProvider: 'git-credential',
    });

    expect(state).toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      passwordMode: 2,
      dataCredentialProvider: 'git-credential',
      dataCredentialHost: 'proton-data.proton-lfs-cli.local',
      willAttemptNetwork: false,
    });
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('reports expired local sessions without refreshing them', async () => {
    mockLoadSession.mockResolvedValue(makeSession({
      tokenExpiresAt: Date.now() - 1_000,
    }));
    mockValidateSession.mockResolvedValue(false);

    const state = await getBridgeAuthState({});

    expect(state).toMatchObject({
      state: 'session_expired',
      hasSession: true,
      sessionValid: false,
      sessionExpired: true,
      willAttemptNetwork: false,
    });
    expect(mockCreateProvider).not.toHaveBeenCalled();
    expect(mockCredentialResolve).not.toHaveBeenCalled();
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });
});

describe('formatCaptchaError', () => {
  it('produces 407 response with captchaUrl in details', () => {
    const err = new CaptchaError({
      captchaUrl: 'https://verify.proton.me/captcha?token=abc',
      captchaToken: 'hvt-abc123',
      verificationMethods: ['captcha'],
    });
    const resp = formatCaptchaError(err);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe(407);
    expect(resp.error).toContain('CAPTCHA verification required');
    const details = JSON.parse(resp.details!);
    expect(details.captchaUrl).toContain('verify.proton.me');
    expect(details.captchaToken).toBe('hvt-abc123');
    expect(details.verificationMethods).toEqual(['captcha']);
    expect(details.action).toBe('run: proton-drive login');
  });

  it('handles empty verificationMethods', () => {
    const err = new CaptchaError({
      captchaUrl: 'https://verify.proton.me/captcha',
      captchaToken: 'hvt-xyz',
    });
    const resp = formatCaptchaError(err);
    expect(resp.code).toBe(407);
    const details = JSON.parse(resp.details!);
    expect(details.verificationMethods).toEqual([]);
  });
});

describe('getInitializedClient', () => {
  beforeEach(() => {
    mockCreateSDKClient.mockReset();
    mockCreateSDKClient.mockResolvedValue({} as any);
    mockCredentialResolve.mockReset();
    mockCreateProvider.mockClear();
  });

  it('does not turn login password into an explicit data password', async () => {
    await getInitializedClient({
      username: 'user@proton.me',
      password: 'login-password',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: undefined,
      secondFactorCode: undefined,
      allowLogin: true,
      appVersion: undefined,
    });
  });

  it('passes explicit data password separately from login password', async () => {
    await getInitializedClient({
      username: 'user@proton.me',
      password: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: '123456',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: '123456',
      allowLogin: true,
      appVersion: undefined,
    });
  });

  it('passes bridge appVersion into SDK client options', async () => {
    await getInitializedClient({
      username: 'user@proton.me',
      password: 'login-password',
      appVersion: 'external-drive-root@9.9.9',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: undefined,
      secondFactorCode: undefined,
      allowLogin: true,
      appVersion: 'external-drive-root@9.9.9',
    });
  });

  it('supports data-password-only session unlock requests', async () => {
    await getInitializedClient({
      dataPassword: 'mailbox-password',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: undefined,
      loginPassword: undefined,
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: false,
      appVersion: undefined,
    });
  });

  it('resolves login credentials from provider while preserving explicit data password', async () => {
    mockCredentialResolve.mockResolvedValue({
      username: 'provider@proton.me',
      password: 'login-password',
    });

    await getInitializedClient({
      credentialProvider: 'git-credential',
      dataPassword: 'mailbox-password',
    });

    expect(mockCredentialResolve).toHaveBeenCalledWith({ username: undefined });
    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'provider@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: true,
      appVersion: undefined,
    });
  });

  it('honors allowLogin=false even when login credentials are available', async () => {
    mockCredentialResolve.mockResolvedValue({
      username: 'provider@proton.me',
      password: 'login-password',
    });

    await getInitializedClient({
      credentialProvider: 'git-credential',
      dataPassword: 'mailbox-password',
      allowLogin: false,
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'provider@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: false,
      appVersion: undefined,
    });
  });

  it('resolves data password from a separate credential provider and host', async () => {
    mockCredentialResolve.mockResolvedValue({
      username: 'user@proton.me',
      password: 'mailbox-password',
    });

    await getInitializedClient({
      username: 'user@proton.me',
      dataCredentialProvider: 'git-credential',
      dataCredentialHost: 'custom-data-host',
    });

    expect(mockCreateProvider).toHaveBeenCalledWith('git-credential', {
      host: 'custom-data-host',
    });
    expect(mockCredentialResolve).toHaveBeenCalledWith({ username: 'user@proton.me' });
    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'user@proton.me',
      loginPassword: undefined,
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: false,
      appVersion: undefined,
    });
  });

  it('uses a distinct default host for provider-backed data passwords', async () => {
    mockCredentialResolve.mockResolvedValue({
      username: 'user@proton.me',
      password: 'mailbox-password',
    });

    await getInitializedClient({
      dataCredentialProvider: 'git-credential',
    });

    expect(mockCreateProvider).toHaveBeenCalledWith('git-credential', {
      host: 'proton-data.proton-lfs-cli.local',
    });
  });

  it('combines login provider credentials with provider-backed data password', async () => {
    mockCredentialResolve
      .mockResolvedValueOnce({
        username: 'provider@proton.me',
        password: 'login-password',
      })
      .mockResolvedValueOnce({
        username: 'provider@proton.me',
        password: 'mailbox-password',
      });

    await getInitializedClient({
      credentialProvider: 'git-credential',
      dataCredentialProvider: 'git-credential',
      dataCredentialHost: 'custom-data-host',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'provider@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: true,
      appVersion: undefined,
    });
  });
});

describe('bridge transfer retry helpers', () => {
  const retryConfig = createRetryConfig({
    initialDelayMs: 1,
    maxDelayMs: 1,
  });
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-transfer-retry-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('retries transient upload completion failures with a fresh uploader', async () => {
    const sourcePath = path.join(tmpDir, 'object.bin');
    await fs.writeFile(sourcePath, 'retry-upload');
    let attempts = 0;
    const client = {
      getFileUploader: jest.fn(async () => ({
        uploadFromStream: jest.fn(async () => ({
          completion: jest.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
              throw { response: { status: 503 } };
            }
            return { nodeUid: 'node-uploaded' };
          }),
        })),
      })),
    };

    await expect(uploadFileWithRetry(
      client as any,
      'parent-uid',
      'object.bin',
      sourcePath,
      'retry-upload'.length,
      retryConfig,
      'test upload'
    )).resolves.toBe('node-uploaded');

    expect(client.getFileUploader).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent upload failures', async () => {
    const sourcePath = path.join(tmpDir, 'object.bin');
    await fs.writeFile(sourcePath, 'permanent-upload');
    const client = {
      getFileUploader: jest.fn(async () => ({
        uploadFromStream: jest.fn(async () => ({
          completion: jest.fn(async () => {
            throw { response: { status: 409 } };
          }),
        })),
      })),
    };

    await expect(uploadFileWithRetry(
      client as any,
      'parent-uid',
      'object.bin',
      sourcePath,
      'permanent-upload'.length,
      retryConfig,
      'test upload permanent'
    )).rejects.toMatchObject({ response: { status: 409 } });

    expect(client.getFileUploader).toHaveBeenCalledTimes(1);
  });

  it('retries transient download failures and removes partial output', async () => {
    const outputPath = path.join(tmpDir, 'download.bin');
    let attempts = 0;
    const client = {
      getFileDownloader: jest.fn(async () => ({
        downloadToStream: jest.fn(() => ({
          completion: jest.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
              await fs.writeFile(outputPath, 'partial');
              throw { response: { status: 503 } };
            }
            await fs.writeFile(outputPath, 'complete');
          }),
        })),
      })),
    };

    await expect(downloadFileWithRetry(
      client as any,
      'node-uid',
      outputPath,
      retryConfig,
      'test download'
    )).resolves.toBe('complete'.length);

    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('complete');
    expect(client.getFileDownloader).toHaveBeenCalledTimes(2);
  });
});
