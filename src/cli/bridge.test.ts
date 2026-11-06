const mockCreateSDKClient = jest.fn();
const mockCredentialResolve = jest.fn();
const mockLoadSession = jest.fn();
const mockValidateSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockKeyPasswordVerify = jest.fn();
const mockFindFileByOid = jest.fn();
const mockDeleteByOid = jest.fn();
const mockListFolder = jest.fn();
const mockEnsureFolderPath = jest.fn();
const mockFindFileNodeInFolder = jest.fn();
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

jest.mock('../sdk/pathResolver', () => ({
  ensureFolderPath: mockEnsureFolderPath,
  findFileNodeInFolder: mockFindFileNodeInFolder,
}));

jest.mock('./bridge-helpers', () => ({
  ...jest.requireActual('./bridge-helpers'),
  findFileByOid: mockFindFileByOid,
  deleteByOid: mockDeleteByOid,
  listFolder: mockListFolder,
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

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    provider: 'git-credential',
    host: 'proton-drive-key.proton-lfs-cli.local',
    verify: mockKeyPasswordVerify,
  })),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { RateLimitedError, ServerError } from '@protontech/drive-sdk';
import {
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
  errorToStatusCode,
  formatCaptchaError,
  formatInsufficientScopeError,
  getBridgeAuthState,
  getInitializedClient,
  runBridgeCommand,
  toBridgeErrorResponse,
  createBridgeCommand,
} from './bridge';
import { BridgeRequest, BridgeResponse } from '../bridge/validators';
import { BRIDGE_AUTH_STATES, BRIDGE_COMMANDS, ERROR_CODE_STATUS } from '../bridge/protocol';
import { createProvider } from '../credentials';
import { AppError, CaptchaError, ErrorCode } from '../errors/types';
import { logger, LogLevel } from '../utils/logger';
import { assertValidAgainstSchema } from '../test/schema-validator';
import type { SessionCredentials } from '../types/auth';

const mockCreateProvider = createProvider as jest.MockedFunction<typeof createProvider>;
const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';
// A second OID whose text contains "9101" (the Proton insufficient-scope code).
const OTHER_OID = `9101aa${VALID_OID.slice(6)}`;

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

function expectSuccessEnvelope(response: BridgeResponse, command: string): any {
  expect(response.ok).toBe(true);
  assertValidAgainstSchema('bridge/v1/response-envelope.schema.json', response);
  assertValidAgainstSchema(`bridge/v1/payloads/${command}.schema.json`, response.payload);
  return response.payload;
}

function expectErrorEnvelope(response: BridgeResponse, code: number, errorCode: ErrorCode): Record<string, unknown> {
  expect(response.ok).toBe(false);
  expect(response.code).toBe(code);
  assertValidAgainstSchema('bridge/v1/response-envelope.schema.json', response);
  const details = JSON.parse(response.details as string);
  assertValidAgainstSchema('bridge/v1/error-details.schema.json', details);
  expect(details.errorCode).toBe(errorCode);
  expect(ERROR_CODE_STATUS[errorCode]).toBe(code);
  return details;
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

  it('does not expose bridge auth, login-shaped or secret request fields', () => {
    expect(BRIDGE_COMMANDS).not.toContain('auth');
    expect(BRIDGE_COMMANDS).not.toContain('refresh');
    expect(BRIDGE_AUTH_STATES).not.toContain('login_available');

    for (const request of [
      { credentialProvider: 'git-credential' },
      { allowLogin: false },
      { username: 'user@proton.me' },
      { dataPassword: 'mailbox-password' },
    ]) {
      expect(() => validateBridgeRequestForCommand('auth-state', request as unknown as BridgeRequest))
        .toThrow(`Unknown bridge request field "${Object.keys(request)[0]}"`);
    }
  });

  it('accepts data-password provider fields for transfer commands', () => {
    expect(() => validateBridgeRequestForCommand('init', {
      dataCredentialProvider: 'pass-cli',
      dataCredentialHost: 'proton-data.proton-lfs-cli.local',
      storageBase: 'LFS',
    })).not.toThrow();
  });

  it('maps structured auth errors to HTTP status codes', () => {
    expect(errorToStatusCode(new AppError('x', ErrorCode.KEY_PASSWORD_REQUIRED))).toBe(401);
    expect(errorToStatusCode(new AppError('x', ErrorCode.RATE_LIMITED))).toBe(429);
    expect(errorToStatusCode(Object.assign(new ServerError('unauthorized'), { statusCode: 401 }))).toBe(401);
    expect(errorToStatusCode(new Error('something else'))).toBe(500);
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
    const payload = await getBridgeAuthState({});
    expect(payload).toMatchObject({
      state: 'needs_login',
      hasSession: false,
      sessionExpired: false,
      willAttemptNetwork: false,
    });
    assertValidAgainstSchema('bridge/v1/auth-state-payload.schema.json', payload);

    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports ready for a valid browser-fork session with key password present', async () => {
    mockLoadSession.mockResolvedValue(makeSession());
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);

    const payload = await getBridgeAuthState({});
    expect(payload).toMatchObject({
      state: 'ready',
      hasSession: true,
      sessionValid: true,
      keyPasswordAvailable: true,
      willAttemptNetwork: false,
    });
    assertValidAgainstSchema('bridge/v1/auth-state-payload.schema.json', payload);
    expect(mockValidateSession).toHaveBeenCalledTimes(1);
    expect(mockValidateSession.mock.calls[0][0]).toMatchObject({ uid: 'session-uid' });
    expect(mockValidateSession.mock.calls[0].slice(1).some((arg: unknown) => arg === true)).toBe(false);

    expectNoAuthStateNetworkOrCredentialSideEffects();
  });

  it('reports session_expired from the local validation result', async () => {
    mockLoadSession.mockResolvedValue(makeSession({ tokenExpiresAt: Date.now() - 1 }));
    mockValidateSession.mockResolvedValue(false);

    const payload = await getBridgeAuthState({});
    expect(payload).toMatchObject({ state: 'session_expired', sessionValid: false, sessionExpired: true });
    assertValidAgainstSchema('bridge/v1/auth-state-payload.schema.json', payload);
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

  it.each([1, 2])('reports needs_data_password for non-browser-fork password mode %i sessions without a data provider', async (passwordMode) => {
    mockLoadSession.mockResolvedValue(makeSession({
      authMode: undefined,
      keyPasswordPersisted: undefined,
      keyPasswordProvider: undefined,
      keyPasswordHost: undefined,
      passwordMode,
    }));
    mockValidateSession.mockResolvedValue(true);

    const payload = await getBridgeAuthState({});
    expect(payload).toMatchObject({ state: 'needs_data_password', passwordMode });
    assertValidAgainstSchema('bridge/v1/auth-state-payload.schema.json', payload);
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

  it('passes the app version to the SDK client without a data password', async () => {
    await getInitializedClient({ appVersion: 'external-drive-root@9.9.9' });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      dataPassword: undefined,
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

describe('runBridgeCommand', () => {
  let tmpDir: string;
  const fakeClient = {
    getFileUploader: jest.fn(),
    getFileDownloader: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
    mockLoadSession.mockResolvedValue(makeSession());
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);
    mockCreateSDKClient.mockReset();
    mockCreateSDKClient.mockResolvedValue(fakeClient);
    mockEnsureFolderPath.mockResolvedValue('folder-uid');
    mockFindFileNodeInFolder.mockResolvedValue(null);
    mockFindFileByOid.mockResolvedValue(null);
    mockDeleteByOid.mockResolvedValue(false);
    mockListFolder.mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers auth-state with a schema-valid envelope', async () => {
    expectSuccessEnvelope(await runBridgeCommand('auth-state', {}), 'auth-state');
  });

  it('rejects unknown commands, non-object requests and forbidden fields with VALIDATION_ERROR', async () => {
    const unknown = await runBridgeCommand('refresh', {});
    expectErrorEnvelope(unknown, 400, ErrorCode.VALIDATION_ERROR);
    expect(unknown.error).toBe('Unknown bridge command: refresh');

    expectErrorEnvelope(await runBridgeCommand('auth-state', 'not an object'), 400, ErrorCode.VALIDATION_ERROR);

    const forbidden = await runBridgeCommand('init', { credentialProvider: 'git-credential' });
    expectErrorEnvelope(forbidden, 400, ErrorCode.VALIDATION_ERROR);
    expect(forbidden.error).toContain('Unknown bridge request field "credentialProvider"');
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('reports a missing required field and a bad OID before touching the SDK', async () => {
    const missing = await runBridgeCommand('download', { outputPath: '/tmp/out' });
    expectErrorEnvelope(missing, 400, ErrorCode.VALIDATION_ERROR);
    expect(missing.error).toContain('oid');

    const bad = await runBridgeCommand('exists', { oid: 'bad' });
    expectErrorEnvelope(bad, 400, ErrorCode.VALIDATION_ERROR);
    expect(bad.error).toContain('Invalid OID');
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('init creates the normalized storage base in one traversal', async () => {
    const payload = expectSuccessEnvelope(await runBridgeCommand('init', { storageBase: '/custom/' }), 'init');
    expect(payload).toEqual({ storageBase: '/custom/', path: '/custom', initialized: true });
    expect(mockEnsureFolderPath).toHaveBeenCalledTimes(1);
    expect(mockEnsureFolderPath).toHaveBeenCalledWith(fakeClient, '/custom');
  });

  it('exists answers exactly { oid, exists }', async () => {
    mockFindFileByOid.mockResolvedValueOnce('node-uid');
    const payload = expectSuccessEnvelope(await runBridgeCommand('exists', { oid: VALID_OID }), 'exists');
    expect(payload).toEqual({ oid: VALID_OID, exists: true });
    expect(mockFindFileByOid).toHaveBeenCalledWith(fakeClient, 'LFS', VALID_OID);
  });

  it('batch-exists and batch-delete answer one boolean per requested OID', async () => {
    mockFindFileByOid.mockImplementation(async (_client: unknown, _base: string, oid: string) => (oid === VALID_OID ? 'uid' : null));
    const exists = expectSuccessEnvelope(await runBridgeCommand('batch-exists', { oids: [VALID_OID, OTHER_OID] }), 'batch-exists');
    expect(exists.results).toEqual({ [VALID_OID]: true, [OTHER_OID]: false });

    mockDeleteByOid.mockImplementation(async (_client: unknown, _base: string, oid: string) => oid === OTHER_OID);
    const deleted = expectSuccessEnvelope(await runBridgeCommand('batch-delete', { oids: [VALID_OID, OTHER_OID] }), 'batch-delete');
    expect(deleted.results).toEqual({ [VALID_OID]: false, [OTHER_OID]: true });
  });

  it('delete reports a missing object as 404 FILE_NOT_FOUND and success as { oid, deleted }', async () => {
    const missing = await runBridgeCommand('delete', { oid: VALID_OID });
    expect(expectErrorEnvelope(missing, 404, ErrorCode.FILE_NOT_FOUND)).toMatchObject({ oid: VALID_OID });

    mockDeleteByOid.mockResolvedValueOnce(true);
    const payload = expectSuccessEnvelope(await runBridgeCommand('delete', { oid: VALID_OID }), 'delete');
    expect(payload).toEqual({ oid: VALID_OID, deleted: true });
  });

  it('list returns the folder listing', async () => {
    mockListFolder.mockResolvedValueOnce([
      { name: '4d', type: 'folder', size: 0, modifiedTime: 0 },
      { name: VALID_OID, type: 'file', size: 12, modifiedTime: 1_700_000_000 },
    ]);
    const payload = expectSuccessEnvelope(await runBridgeCommand('list', { folder: '/LFS/4d' }), 'list');
    expect(payload.files).toHaveLength(2);
    expect(mockListFolder).toHaveBeenCalledWith(fakeClient, '/LFS/4d');
  });

  it('upload creates the OID folder chain once, then deduplicates against the parent listing', async () => {
    const filePath = path.join(tmpDir, 'object.bin');
    fs.writeFileSync(filePath, 'hello');
    mockFindFileNodeInFolder.mockResolvedValueOnce({ uid: 'existing-uid', activeRevision: { uid: 'rev-1' } });

    const payload = expectSuccessEnvelope(await runBridgeCommand('upload', { oid: VALID_OID, path: filePath }), 'upload');
    expect(payload).toEqual({ oid: VALID_OID, fileId: 'existing-uid', revisionId: 'rev-1', uploaded: false, deduplicated: true });
    expect(mockEnsureFolderPath).toHaveBeenCalledTimes(1);
    expect(mockEnsureFolderPath).toHaveBeenCalledWith(fakeClient, '/LFS/4d/7a');
    expect(mockFindFileNodeInFolder).toHaveBeenCalledWith(fakeClient, 'folder-uid', VALID_OID);
    expect(fakeClient.getFileUploader).not.toHaveBeenCalled();
  });

  it('upload streams a new object and reports node and revision UIDs', async () => {
    const filePath = path.join(tmpDir, 'object.bin');
    fs.writeFileSync(filePath, 'hello');
    fakeClient.getFileUploader.mockResolvedValue({
      uploadFromStream: async (stream: ReadableStream) => {
        for await (const _chunk of stream as unknown as AsyncIterable<Uint8Array>) { /* drain */ }
        return { completion: async () => ({ nodeUid: 'new-uid', nodeRevisionUid: 'new-rev' }) };
      },
    });

    const payload = expectSuccessEnvelope(await runBridgeCommand('upload', { oid: VALID_OID, path: filePath }), 'upload');
    expect(payload).toEqual({ oid: VALID_OID, fileId: 'new-uid', revisionId: 'new-rev', uploaded: true, deduplicated: false });
    expect(fakeClient.getFileUploader).toHaveBeenCalledWith('folder-uid', VALID_OID, { mediaType: 'application/octet-stream', expectedSize: 5 });
  });

  it('upload of a missing local file fails as 404 FILE_NOT_FOUND before the SDK is used', async () => {
    const response = await runBridgeCommand('upload', { oid: VALID_OID, path: path.join(tmpDir, 'missing') });
    expectErrorEnvelope(response, 404, ErrorCode.FILE_NOT_FOUND);
    expect(mockCreateSDKClient).not.toHaveBeenCalled();
  });

  it('download writes the object with mode 0600, waits for the flush and reports the size', async () => {
    const outputPath = path.join(tmpDir, 'download.bin');
    mockFindFileByOid.mockResolvedValueOnce('node-uid');
    fakeClient.getFileDownloader.mockResolvedValue({
      downloadToStream: (stream: WritableStream) => ({
        completion: async () => {
          const writer = stream.getWriter();
          await writer.write(new TextEncoder().encode('twelve bytes'));
          await writer.close();
        },
      }),
    });

    const payload = expectSuccessEnvelope(await runBridgeCommand('download', { oid: VALID_OID, outputPath }), 'download');
    expect(payload).toEqual({ oid: VALID_OID, outputPath, size: 12, downloaded: true });
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('twelve bytes');
    if (process.platform !== 'win32') {
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    }
  });

  it('download of an unknown OID is 404 FILE_NOT_FOUND', async () => {
    const response = await runBridgeCommand('download', { oid: VALID_OID, outputPath: path.join(tmpDir, 'x') });
    expectErrorEnvelope(response, 404, ErrorCode.FILE_NOT_FOUND);
  });

  it('keeps the HTTP status of SDK server errors instead of reporting 502', async () => {
    mockCreateSDKClient.mockRejectedValueOnce(Object.assign(new ServerError('Invalid access token'), { statusCode: 401, code: 10013 }));
    const unauthorized = await runBridgeCommand('exists', { oid: VALID_OID });
    expect(expectErrorEnvelope(unauthorized, 401, ErrorCode.AUTH_FAILED)).toMatchObject({ statusCode: 401, protonCode: 10013 });

    mockCreateSDKClient.mockRejectedValueOnce(Object.assign(new ServerError('Forbidden'), { statusCode: 403 }));
    expectErrorEnvelope(await runBridgeCommand('exists', { oid: VALID_OID }), 403, ErrorCode.PERMISSION_DENIED);

    mockCreateSDKClient.mockRejectedValueOnce(Object.assign(new ServerError('Upstream'), { statusCode: 503 }));
    expectErrorEnvelope(await runBridgeCommand('exists', { oid: VALID_OID }), 502, ErrorCode.API_ERROR);
  });

  it('reports SDK rate limiting as 429 with retry guidance', async () => {
    mockCreateSDKClient.mockRejectedValueOnce(Object.assign(new RateLimitedError('Too many requests'), { statusCode: 429, code: 85131 }));
    const response = await runBridgeCommand('exists', { oid: VALID_OID });
    const details = expectErrorEnvelope(response, 429, ErrorCode.RATE_LIMITED);
    expect(details).toMatchObject({ protonCode: 85131 });
    expect(response.error).toContain('Rate limited by Proton API');
  });

  it('classifies insufficient scope by the structured Proton code only', async () => {
    mockCreateSDKClient.mockRejectedValueOnce(Object.assign(new ServerError('Access token does not have sufficient scope'), { statusCode: 403, code: 9101 }));
    const scoped = await runBridgeCommand('exists', { oid: VALID_OID });
    expect(expectErrorEnvelope(scoped, 403, ErrorCode.INSUFFICIENT_SCOPE)).toMatchObject({ protonCode: 9101 });

    mockCreateSDKClient.mockRejectedValueOnce(new Error(`File not found for OID: ${OTHER_OID}`));
    expectErrorEnvelope(await runBridgeCommand('exists', { oid: OTHER_OID }), 500, ErrorCode.UNKNOWN_ERROR);
  });

  it('redacts secrets from error details', async () => {
    mockCreateSDKClient.mockRejectedValueOnce(new AppError('failed', ErrorCode.AUTH_FAILED, { uid: 'secret-uid', accessToken: 'token-value', statusCode: 401 }));
    const response = await runBridgeCommand('exists', { oid: VALID_OID });
    const details = expectErrorEnvelope(response, 401, ErrorCode.AUTH_FAILED);
    expect(details).toMatchObject({ uid: '[redacted]', accessToken: '[redacted]', statusCode: 401 });
    expect(response.details).not.toContain('token-value');
  });
});

describe('toBridgeErrorResponse', () => {
  it('formats CAPTCHA errors with the structured details', () => {
    const response = toBridgeErrorResponse(new CaptchaError({
      captchaUrl: 'https://verify.proton.me',
      captchaToken: 'token',
      verificationMethods: ['captcha'],
    }));

    expect(response.ok).toBe(false);
    expect(response.code).toBe(407);
    assertValidAgainstSchema('bridge/v1/response-envelope.schema.json', response);
    const details = JSON.parse(response.details as string);
    assertValidAgainstSchema('bridge/v1/error-details.schema.json', details);
    expect(details).toMatchObject({
      errorCode: ErrorCode.CAPTCHA_REQUIRED,
      captchaUrl: 'https://verify.proton.me',
      captchaToken: 'token',
      action: 'run: proton-drive-cli login',
    });
    expect(formatCaptchaError(new CaptchaError({ captchaUrl: 'u', captchaToken: 't' }))).toMatchObject({ code: 407 });
  });

  it('formats insufficient scope with the stop action', () => {
    const response = formatInsufficientScopeError(
      new Error('API Error (9101): Access token does not have sufficient scope')
    );

    expect(response.ok).toBe(false);
    expect(response.code).toBe(403);
    expect(JSON.parse(response.details as string)).toMatchObject({
      errorCode: ErrorCode.INSUFFICIENT_SCOPE,
      protonCode: 9101,
      action: expect.stringContaining('do not retry login loops'),
    });
  });
});

describe('createBridgeCommand stdout contract', () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalDebug = process.env.DEBUG;
  const originalLevel = logger.getLevel();

  function useStdin(content: string): void {
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(Readable.from([content]), { isTTY: false }),
      configurable: true,
    });
  }

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    if (originalDebug === undefined) delete process.env.DEBUG; else process.env.DEBUG = originalDebug;
    logger.setLevel(originalLevel);
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  it('writes exactly one JSON envelope to stdout and keeps logs on stderr', async () => {
    jest.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
    mockValidateSession.mockResolvedValue(false);
    process.env.DEBUG = 'true';
    logger.setLevel(LogLevel.DEBUG);
    useStdin('{}\n');
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockLoadSession.mockImplementation(async () => {
      logger.info('loading session');
      return null;
    });

    await createBridgeCommand().parseAsync(['auth-state'], { from: 'user' });

    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    const line = String(stdoutWrite.mock.calls[0][0]);
    expect(line.endsWith('\n')).toBe(true);
    const envelope = JSON.parse(line);
    expectSuccessEnvelope(envelope, 'auth-state');
    expect(envelope.payload.state).toBe('needs_login');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[INFO]'), 'loading session');
    expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining('{'));
    expect(process.exitCode).toBeUndefined();
  });

  it('reports unreadable input as an error envelope and sets exitCode 1 without exiting', async () => {
    useStdin('not json');
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await createBridgeCommand().parseAsync(['auth-state'], { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(String(stdoutWrite.mock.calls[0][0]));
    expectErrorEnvelope(envelope, 400, ErrorCode.VALIDATION_ERROR);
    expect(envelope.error).toContain('Failed to parse JSON');
  });
});
