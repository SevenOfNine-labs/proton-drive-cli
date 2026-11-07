/**
 * Logout against the real SessionManager and session lock while a login
 * replaces the session: only the session logout ended is removed.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import { AuthService } from './index';
import { SessionManager } from './session';
import { SESSION_FILE } from './state-dir';
import type { SessionCredentials } from '../types/auth';
import { memorySessionSecrets, MemorySessionSecrets } from '../test/memory-session-secrets';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-logout-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');
jest.mock('./session-secrets', () => jest.requireActual('../test/memory-session-secrets').mockSessionSecretsModule());

const HOST = 'proton-drive-cli.invalid';
const base = {
  scopes: ['full'],
  keyPassword: 'key-password',
  credentialStore: 'pass-cli' as const,
  credentialHost: HOST,
  tokenExpiresAt: Date.now() + 3_600_000,
};
const ended: Omit<SessionCredentials, 'revision'> = { ...base, uid: 'uid-A', accessToken: 'access-A', refreshToken: 'refresh-A' };
const next: Omit<SessionCredentials, 'revision'> = { ...base, uid: 'uid-B', accessToken: 'access-B', refreshToken: 'refresh-B' };

afterAll(async () => {
  await fs.remove(os.homedir());
});

beforeEach(() => {
  memorySessionSecrets.reset();
});

it('keeps a session a concurrent login wrote while logout revoked the previous one', async () => {
  await SessionManager.replaceSession(ended);
  let written: SessionCredentials | undefined;
  global.fetch = jest.fn(async () => {
    written = (await SessionManager.replaceSession(next)).session;
    return new Response(JSON.stringify({ Code: 1000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

  expect(memorySessionSecrets.removes).toEqual([MemorySessionSecrets.key('pass-cli', HOST, 'uid-A')]);
  expect(memorySessionSecrets.get('pass-cli', HOST, 'uid-B')).toMatchObject({ accessToken: 'access-B' });
  expect(await fs.readJson(SESSION_FILE)).toMatchObject({ uid: 'uid-B', revision: written?.revision });
});

it('revokes the session with the access token of its credential-store entry', async () => {
  await SessionManager.replaceSession(ended);
  const authorizations: string[] = [];
  global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(String((init?.headers as Record<string, string>)?.Authorization));
    return new Response(JSON.stringify({ Code: 1000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

  expect(authorizations).toEqual(['Bearer access-A']);
  expect(memorySessionSecrets.get('pass-cli', HOST, 'uid-A')).toBeUndefined();
  expect(await fs.pathExists(SESSION_FILE)).toBe(false);
});

it('clears the local session without revoking when the credential store cannot return the entry', async () => {
  await SessionManager.replaceSession(ended);
  await fs.writeJson(SESSION_FILE, { ...(await fs.readJson(SESSION_FILE)), revision: 'written-by-another-process' });
  memorySessionSecrets.entries.clear();
  global.fetch = jest.fn() as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: false, credentialsRemoved: true });

  expect(global.fetch).not.toHaveBeenCalled();
  expect(memorySessionSecrets.removes).toEqual([MemorySessionSecrets.key('pass-cli', HOST, 'uid-A')]);
  expect(await fs.pathExists(SESSION_FILE)).toBe(false);
});

it('deletes session.json before the entry, so a refresh during the logout leaves no entry behind', async () => {
  await SessionManager.replaceSession(ended);
  const sessionFileAtRemoval: boolean[] = [];
  memorySessionSecrets.onRemove = async () => {
    sessionFileAtRemoval.push(await fs.pathExists(SESSION_FILE));
  };
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/auth/v4/refresh')) {
      return new Response(JSON.stringify({ Code: 1000, UID: 'uid-A', AccessToken: 'access-A2', RefreshToken: 'refresh-A2', ExpiresIn: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    await SessionManager.refreshSession(undefined);
    return new Response(JSON.stringify({ Code: 1000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

  expect(sessionFileAtRemoval).toEqual([false]);
  expect(memorySessionSecrets.get('pass-cli', HOST, 'uid-A')).toBeUndefined();
  expect(await fs.pathExists(SESSION_FILE)).toBe(false);
});

it('reports credentialsRemoved false when the sign-out during the revocation cannot remove the entry', async () => {
  await SessionManager.replaceSession(ended);
  memorySessionSecrets.removeError = new Error('pass-cli is not logged in');
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  global.fetch = jest.fn(async (url: string | URL | Request) => (
    String(url).includes('/auth/v4/refresh')
      ? json(400, { Code: 10013, Error: 'Invalid refresh token' })
      : json(401, { Code: 401, Error: 'Invalid access token' })
  )) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: false });

  expect(await fs.pathExists(SESSION_FILE)).toBe(false);
  expect(memorySessionSecrets.removes).toEqual([MemorySessionSecrets.key('pass-cli', HOST, 'uid-A')]);
});

it('reports credentialsRemoved false when the credential store keeps the entry', async () => {
  await SessionManager.replaceSession(ended);
  memorySessionSecrets.removeError = new Error('pass-cli is not logged in');
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ Code: 1000 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: false });

  expect(await fs.pathExists(SESSION_FILE)).toBe(false);
});
