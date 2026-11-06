import { AuthApiClient } from '../api/auth';
import { AuthService } from './index';
import { BRIDGE_COMMANDS, BRIDGE_REQUEST_FIELDS } from '../bridge/protocol';

describe('browser-fork auth policy', () => {
  it('creates sessions only through the Proton session fork', () => {
    expect(Object.getOwnPropertyNames(AuthApiClient.prototype).sort()).toEqual([
      'constructor',
      'getSessionForkStatus',
      'initSessionFork',
      'logout',
      'refreshToken',
    ]);
    expect('login' in new AuthService()).toBe(false);
  });

  it('keeps login commands and secret-shaped fields out of the bridge protocol', () => {
    expect(BRIDGE_COMMANDS).not.toContain('login');
    for (const field of BRIDGE_REQUEST_FIELDS) {
      expect(field).not.toMatch(/password|secret|token|credential|username|login/i);
    }
  });
});
