import * as fs from 'fs';
import * as path from 'path';
import { AuthApiClient } from '../api/auth';
import { AuthService } from './index';
import { BRIDGE_AUTH_STATES, BRIDGE_COMMANDS, BRIDGE_REQUEST_FIELDS } from '../bridge/protocol';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

describe('browser-fork auth policy', () => {
  it('does not expose direct account-password methods on auth services', () => {
    expect('login' in new AuthService()).toBe(false);
    expect('getAuthInfo' in new AuthApiClient()).toBe(false);
    expect('authenticate' in new AuthApiClient()).toBe(false);
    expect('complete2FA' in new AuthApiClient()).toBe(false);
  });

  it('keeps SRP account-login endpoints out of production auth modules', () => {
    const directLoginEndpoint = ['/auth/v4', '/info'].join('');
    const directLoginSubmit = ['authenticate', '('].join('');
    const twoFactorSubmit = ['complete2FA', '('].join('');
    const authSources = [
      'src/api/auth.ts',
      'src/auth/index.ts',
      'src/sdk/client.ts',
      'src/cli/login.ts',
      'src/cli/bridge.ts',
    ].map(readSource).join('\n');

    expect(authSources).not.toContain(directLoginEndpoint);
    expect(authSources).not.toContain(directLoginSubmit);
    expect(authSources).not.toContain(twoFactorSubmit);
    expect(authSources).not.toContain('loginPassword');
    expect(authSources).not.toContain('allowLogin');
  });

  it('keeps bridge protocol free of login commands and login-shaped fields', () => {
    expect(BRIDGE_COMMANDS).not.toContain('auth');
    expect(BRIDGE_AUTH_STATES).not.toContain('login_available');
    expect(BRIDGE_REQUEST_FIELDS).not.toEqual(expect.arrayContaining([
      'username',
      'password',
      'credentialProvider',
      'secondFactorCode',
      'allowLogin',
    ]));
  });

  it('documents the remaining SRP modules as SDK key-derivation plumbing only', () => {
    const sdkClient = readSource('src/sdk/client.ts');
    const authIndex = readSource('src/auth/index.ts');

    expect(sdkClient).toContain('SDK-required key derivation adapter; not account login');
    expect(authIndex).toContain('cannot create Proton account sessions from username/password');
  });
});
