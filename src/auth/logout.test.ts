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

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-logout-'));
  return { ...actual, homedir: () => home };
});
jest.mock('../utils/logger');
const mockRemovedKeyPasswords: string[] = [];
jest.mock('./key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    remove: async (uid: string) => { mockRemovedKeyPasswords.push(uid); },
  })),
}));

const base = {
  scopes: ['full'],
  keyPasswordProvider: 'pass-cli' as const,
  keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  tokenExpiresAt: Date.now() + 3_600_000,
};
const ended: SessionCredentials = { ...base, uid: 'uid-A', accessToken: 'access-A', refreshToken: 'refresh-A' };
const next: SessionCredentials = { ...base, uid: 'uid-B', accessToken: 'access-B', refreshToken: 'refresh-B' };

afterAll(async () => {
  await fs.remove(os.homedir());
});

it('keeps a session a concurrent login wrote while logout revoked the previous one', async () => {
  await SessionManager.replaceSession(ended);
  global.fetch = jest.fn(async () => {
    await SessionManager.replaceSession(next);
    return new Response(JSON.stringify({ Code: 1000 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await expect(new AuthService().logout()).resolves.toEqual({ revoked: true });

  expect(mockRemovedKeyPasswords).toEqual(['uid-A']);
  expect(await fs.readJson(SESSION_FILE)).toEqual(next);
});
