/**
 * Refresh traffic of the SDK HTTP adapter against the real SessionManager:
 * no refresh before an HTTP 401 (official ApiClient), and one refresh for all
 * requests rejected with the same access token.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { SessionManager } from '../auth/session';
import { clearRateLimitCooldown } from '../auth/rate-limit';
import { HTTPClientAdapter } from './httpClientAdapter';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-adapter-refresh-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');

const nearExpiry = {
  uid: 'uid-A',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  scopes: [],
  keyPasswordProvider: 'pass-cli' as const,
  keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  tokenExpiresAt: Date.now() + 60_000,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parallelRequests(adapter: HTTPClientAdapter, count: number): Promise<Response[]> {
  return Promise.all(Array.from({ length: count }, () => adapter.fetchJson({
    url: '/drive/v2/volumes',
    method: 'GET',
    headers: new Headers(),
    timeoutMs: 30_000,
  })));
}

beforeEach(async () => {
  await clearRateLimitCooldown();
});

afterAll(async () => {
  await fs.remove(os.homedir());
});

it('sends no refresh for a token close to its expiry while the API accepts it', async () => {
  await SessionManager.replaceSession(nearExpiry);
  const urls: string[] = [];
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return json(200, { Code: 1000 });
  }) as typeof fetch;

  await parallelRequests(new HTTPClientAdapter(), 8);

  expect(urls).toHaveLength(8);
  expect(urls).not.toContain('https://drive-api.proton.me/auth/v4/refresh');
});

it('sends one refresh for parallel requests rejected with the same token while the refresh endpoint fails', async () => {
  await SessionManager.replaceSession({ ...nearExpiry, accessToken: 'access-2' });
  let refreshes = 0;
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/auth/v4/refresh')) {
      refreshes++;
      return json(503, { Code: 503, Error: 'Unavailable' });
    }
    return json(401, { Code: 401, Error: 'Invalid access token' });
  }) as typeof fetch;

  const adapter = new HTTPClientAdapter();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => adapter.fetchJson({
    url: '/drive/v2/volumes',
    method: 'GET',
    headers: new Headers(),
    timeoutMs: 30_000,
  })));

  expect(results.every((result) => result.status === 'rejected' && result.reason.code === 'API_ERROR' && result.reason.isRecoverable)).toBe(true);
  expect(refreshes).toBe(1);
});
