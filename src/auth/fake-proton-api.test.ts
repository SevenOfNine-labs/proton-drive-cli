import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'fs-extra';
import type { AuthResponse } from '../types/auth';

const APP_VERSION = 'external-drive-test@0.0.0';
const USERNAME = 'user@proton.me';
const PASSWORD = 'login-password';

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface FakeApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface FakeApiServer {
  baseUrl: string;
  records: RecordedRequest[];
  errors: unknown[];
  close: () => Promise<void>;
}

function makeAuthResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
  return {
    UID: 'uid-1',
    AccessToken: 'access-token',
    RefreshToken: 'refresh-token',
    TokenType: 'Bearer',
    Scopes: ['full'],
    ServerProof: 'server-proof',
    PasswordMode: 1,
    '2FA': {
      Enabled: 0,
      FIDO2: { RegisteredKeys: [] },
      TOTP: 0,
    },
    ...overrides,
  };
}

function makeAuthInfoResponse() {
  return {
    Modulus: 'modulus',
    ServerEphemeral: 'server-ephemeral',
    Version: 4,
    Salt: 'salt',
    SRPSession: 'srp-session',
  };
}

function expectNoRouteErrors(server: FakeApiServer): void {
  if (server.errors.length > 0) {
    throw server.errors[0];
  }
}

async function startFakeProtonApi(
  handler: (request: RecordedRequest) => FakeApiResponse | Promise<FakeApiResponse>
): Promise<FakeApiServer> {
  const records: RecordedRequest[] = [];
  const errors: unknown[] = [];

  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const record: RecordedRequest = {
        method: req.method || 'GET',
        path: url.pathname,
        headers: req.headers,
        body,
      };
      records.push(record);

      const response = await handler(record);
      res.statusCode = response.status || 200;
      res.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(response.headers || {})) {
        res.setHeader(name, value);
      }
      res.end(response.body === undefined ? '' : JSON.stringify(response.body));
    } catch (error) {
      errors.push(error);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    records,
    errors,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function installLocalhostOnlyFetchGuard(): () => void {
  const originalFetch = global.fetch;
  if (!originalFetch) {
    throw new Error('Global fetch is required for auth integration tests');
  }

  global.fetch = (async (input: any, init?: any) => {
    const requestUrl = typeof input === 'string' || input instanceof URL
      ? input.toString()
      : input.url;
    const url = new URL(requestUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error(`Live Proton network blocked in auth test: ${url.hostname}`);
    }
    return originalFetch(input, init);
  }) as typeof global.fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

function unmockAuthModules(): void {
  for (const moduleName of [
    'fs-extra',
    'os',
    '../api/auth',
    '../api/http-client',
    '../errors/types',
    '../utils/logger',
    './index',
    './session',
    './srp',
  ]) {
    jest.dontMock(moduleName);
  }
}

async function loadAuthHarness(tempHome: string) {
  jest.resetModules();
  unmockAuthModules();

  const actualOs = jest.requireActual<typeof import('os')>('os');
  jest.doMock('os', () => ({
    ...actualOs,
    homedir: () => tempHome,
  }));
  jest.doMock('../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  const { AuthService } = await import('./index');
  const { SessionManager } = await import('./session');
  const { SRPClient } = await import('./srp');
  const { CaptchaError, ErrorCode } = await import('../errors/types');

  jest.spyOn(SRPClient, 'computeHandshake').mockResolvedValue({
    clientEphemeral: 'client-ephemeral',
    clientProof: 'client-proof',
    expectedServerProof: 'server-proof',
  });
  jest.spyOn(SRPClient, 'verifyServerProof').mockReturnValue(true);

  return { AuthService, CaptchaError, ErrorCode, SessionManager };
}

async function createHarness() {
  const tempHome = await mkdtemp(join(tmpdir(), 'proton-drive-auth-'));
  const restoreFetch = installLocalhostOnlyFetchGuard();
  const modules = await loadAuthHarness(tempHome);

  return {
    ...modules,
    tempHome,
    cleanup: async () => {
      restoreFetch();
      await rm(tempHome, { recursive: true, force: true });
      jest.restoreAllMocks();
      jest.dontMock('os');
    },
  };
}

function assertAppVersionHeaders(records: RecordedRequest[]): void {
  for (const record of records) {
    expect(record.headers['x-pm-appversion']).toBe(APP_VERSION);
  }
}

describe('AuthService against a fake Proton API', () => {
  it('completes one-password SRP login and saves only safe session data', async () => {
    const harness = await createHarness();
    const server = await startFakeProtonApi(request => {
      if (request.path === '/auth/v4/info') {
        expect(request.method).toBe('POST');
        expect(request.body).toEqual({ Username: USERNAME });
        return { body: makeAuthInfoResponse() };
      }

      if (request.path === '/auth/v4') {
        expect(request.method).toBe('POST');
        expect(request.body).toEqual({
          Username: USERNAME,
          ClientEphemeral: 'client-ephemeral',
          ClientProof: 'client-proof',
          SRPSession: 'srp-session',
        });
        return { body: makeAuthResponse() };
      }

      throw new Error(`Unexpected auth endpoint: ${request.method} ${request.path}`);
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);
      const session = await authService.login(USERNAME, PASSWORD);
      const sessionFile = harness.SessionManager.getSessionFilePath();
      const sessionJson = JSON.parse(await readFile(sessionFile, 'utf8'));
      const sessionMode = (await stat(sessionFile)).mode & 0o777;
      const sessionDirMode = (await stat(dirname(sessionFile))).mode & 0o777;

      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
        'POST /auth/v4',
      ]);
      assertAppVersionHeaders(server.records);
      expect(session).toMatchObject({
        sessionId: 'uid-1',
        uid: 'uid-1',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        passwordMode: 1,
      });
      expect(sessionFile.startsWith(harness.tempHome)).toBe(true);
      expect(sessionMode & 0o077).toBe(0);
      expect(sessionDirMode & 0o077).toBe(0);
      expect(JSON.stringify(sessionJson)).not.toContain(PASSWORD);
      expect(sessionJson).not.toHaveProperty('password');
      expect(sessionJson).not.toHaveProperty('loginPassword');
      expect(sessionJson).not.toHaveProperty('mailboxPassword');
      expect(sessionJson.userHash).toBe(harness.SessionManager.hashUsername(USERNAME));
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it('completes TOTP before persisting the session file', async () => {
    const harness = await createHarness();
    const sessionFile = harness.SessionManager.getSessionFilePath();
    const server = await startFakeProtonApi(async request => {
      if (request.path === '/auth/v4/info') {
        return { body: makeAuthInfoResponse() };
      }

      if (request.path === '/auth/v4') {
        return {
          body: makeAuthResponse({
            '2FA': {
              Enabled: 1,
              FIDO2: { RegisteredKeys: [] },
              TOTP: 1,
            },
          }),
        };
      }

      if (request.path === '/auth/v4/2fa') {
        expect(await fs.pathExists(sessionFile)).toBe(false);
        expect(request.method).toBe('POST');
        expect(request.headers.authorization).toBe('Bearer access-token');
        expect(request.headers['x-pm-uid']).toBe('uid-1');
        expect(request.body).toEqual({ TwoFactorCode: '123456' });
        return { body: {} };
      }

      throw new Error(`Unexpected auth endpoint: ${request.method} ${request.path}`);
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);
      await authService.login(USERNAME, PASSWORD, { secondFactorCode: '123456' });

      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
        'POST /auth/v4',
        'POST /auth/v4/2fa',
      ]);
      assertAppVersionHeaders(server.records);
      expect(await fs.pathExists(sessionFile)).toBe(true);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it('stops on FIDO2-only accounts without saving a partial session', async () => {
    const harness = await createHarness();
    const sessionFile = harness.SessionManager.getSessionFilePath();
    const server = await startFakeProtonApi(request => {
      if (request.path === '/auth/v4/info') {
        return { body: makeAuthInfoResponse() };
      }

      if (request.path === '/auth/v4') {
        return {
          body: makeAuthResponse({
            '2FA': {
              Enabled: 2,
              FIDO2: { RegisteredKeys: [{ keyHandle: 'key-1', publicKey: 'public-key' }] },
              TOTP: 0,
            },
          }),
        };
      }

      throw new Error(`Unexpected auth endpoint: ${request.method} ${request.path}`);
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);

      await expect(authService.login(USERNAME, PASSWORD)).rejects.toMatchObject({
        code: harness.ErrorCode.TWO_FACTOR_REQUIRED,
        details: {
          twoFactorType: 'fido2',
          fido2Available: true,
          totpAllowed: false,
        },
      });
      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
        'POST /auth/v4',
      ]);
      expect(await fs.pathExists(sessionFile)).toBe(false);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it('surfaces human verification without retrying or saving a session', async () => {
    const harness = await createHarness();
    const sessionFile = harness.SessionManager.getSessionFilePath();
    const server = await startFakeProtonApi(request => {
      expect(request.path).toBe('/auth/v4/info');
      return {
        status: 422,
        body: {
          Code: 9001,
          Error: 'Human verification required',
          Details: {
            HumanVerificationToken: 'verification-token',
            WebUrl: 'https://verify.proton.me',
            HumanVerificationMethods: ['captcha'],
          },
        },
      };
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);

      await expect(authService.login(USERNAME, PASSWORD)).rejects.toBeInstanceOf(
        harness.CaptchaError
      );
      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
      ]);
      expect(await fs.pathExists(sessionFile)).toBe(false);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it('surfaces rate limits without retrying or saving a session', async () => {
    const harness = await createHarness();
    const sessionFile = harness.SessionManager.getSessionFilePath();
    const server = await startFakeProtonApi(request => {
      expect(request.path).toBe('/auth/v4/info');
      return {
        status: 429,
        headers: { 'retry-after': '60' },
        body: {
          Code: 2028,
          Error: 'Too many requests',
        },
      };
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);

      await expect(authService.login(USERNAME, PASSWORD)).rejects.toMatchObject({
        code: harness.ErrorCode.RATE_LIMITED,
        message: 'Too many requests',
      });
      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
      ]);
      expect(await fs.pathExists(sessionFile)).toBe(false);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it('does not retry wrong credentials or save a session', async () => {
    const harness = await createHarness();
    const sessionFile = harness.SessionManager.getSessionFilePath();
    const server = await startFakeProtonApi(request => {
      if (request.path === '/auth/v4/info') {
        return { body: makeAuthInfoResponse() };
      }

      if (request.path === '/auth/v4') {
        return {
          status: 401,
          body: {
            Code: 8002,
            Error: 'Invalid login credentials',
          },
        };
      }

      throw new Error(`Unexpected auth endpoint: ${request.method} ${request.path}`);
    });

    try {
      const authService = new harness.AuthService(server.baseUrl, APP_VERSION);

      await expect(authService.login(USERNAME, PASSWORD)).rejects.toThrow(
        'Login failed during auth-submit: Request failed with status 401'
      );
      expectNoRouteErrors(server);
      expect(server.records.map(record => `${record.method} ${record.path}`)).toEqual([
        'POST /auth/v4/info',
        'POST /auth/v4',
      ]);
      expect(await fs.pathExists(sessionFile)).toBe(false);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });
});
