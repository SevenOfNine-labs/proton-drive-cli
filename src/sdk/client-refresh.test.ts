/**
 * Refresh of a locally expired session at client creation against the real
 * SessionManager: a failure a later attempt can overcome keeps its own bridge
 * code instead of asking for a new login.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { SessionManager } from '../auth/session';
import { clearRateLimitCooldown } from '../auth/rate-limit';
import { toBridgeErrorResponse } from '../cli/bridge';
import { createSDKClient } from './client';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-client-refresh-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');
jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({ provider: 'pass-cli', host: 'h', load: async () => 'kp', remove: async () => {} })),
}));

const expired = {
  uid: 'uid-A',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  scopes: [],
  keyPasswordProvider: 'pass-cli' as const,
  keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  tokenExpiresAt: Date.now() - 1_000,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(async () => {
  await clearRateLimitCooldown();
});

afterAll(async () => {
  await fs.remove(os.homedir());
});

it.each([
  ['a rate limit', 'access-429', () => json(429, { Code: 2028, Error: 'Too many requests' }, { 'retry-after': '30' }), 'RATE_LIMITED', 429],
  ['a server error', 'access-503', () => json(503, { Code: 503, Error: 'Unavailable' }), 'API_ERROR', 502],
  ['a network failure', 'access-net', () => { throw new TypeError('fetch failed'); }, 'NETWORK_ERROR', 502],
])('reports %s during the refresh with its own code and keeps the session', async (_label, accessToken, respond, errorCode, status) => {
  const session = { ...expired, accessToken };
  await SessionManager.replaceSession(session);
  global.fetch = jest.fn(async () => respond()) as typeof fetch;

  const envelope = toBridgeErrorResponse(await createSDKClient({}).catch((error: unknown) => error));

  expect(JSON.parse(envelope.details ?? '{}').errorCode).toBe(errorCode);
  expect(envelope.code).toBe(status);
  expect(await SessionManager.loadSession()).toEqual(session);
});
