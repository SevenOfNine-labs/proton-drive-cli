import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import {
  DEFAULT_PROTON_APP_VERSION,
  VENDORED_DRIVE_SDK_VERSION,
  assertValidProtonAppVersion,
  getProtonAppVersion,
  isValidProtonAppVersion,
} from './constants';
import { version as pkgVersion } from '../package.json';

describe('Proton app version constants', () => {
  const originalEnv = process.env.PROTON_DRIVE_CLI_APP_VERSION;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PROTON_DRIVE_CLI_APP_VERSION;
    } else {
      process.env.PROTON_DRIVE_CLI_APP_VERSION = originalEnv;
    }
  });

  test('uses an SDK-shaped default app version tied to package.json', () => {
    expect(DEFAULT_PROTON_APP_VERSION).toBe(`external-drive-protonlfscli@${pkgVersion}`);
    expect(isValidProtonAppVersion(DEFAULT_PROTON_APP_VERSION)).toBe(true);
  });

  test('accepts the official third-party grammar incl. channel and build metadata', () => {
    expect(assertValidProtonAppVersion('external-drive-sdkclijs@0.0.0')).toBe(
      'external-drive-sdkclijs@0.0.0'
    );
    expect(isValidProtonAppVersion('external-drive-myapp@1.2.3-stable')).toBe(true);
    expect(isValidProtonAppVersion('external-drive-my_app@2.0.0-beta')).toBe(true);
    expect(isValidProtonAppVersion('external-drive-photo_backup@1.0.0-alpha+abc123f')).toBe(true);
  });

  test('rejects the reserved official cli-drive identity', () => {
    expect(isValidProtonAppVersion('cli-drive@1.2.3')).toBe(false);
    expect(isValidProtonAppVersion('cli-drive-fedora@1.2.3')).toBe(false);
    expect(() => assertValidProtonAppVersion('cli-drive@1.2.3')).toThrow('Invalid Proton app version');
  });

  test('rejects app version sections with extra dash-separated parts', () => {
    expect(isValidProtonAppVersion('external-drive-proton-lfs-cli@0.1.2')).toBe(false);
    expect(() => assertValidProtonAppVersion('external-drive-proton-lfs-cli@0.1.2'))
      .toThrow('Invalid Proton app version');
  });

  test('rejects non-semver versions and unknown channels', () => {
    expect(isValidProtonAppVersion('external-drive-protonlfs@dev')).toBe(false);
    expect(isValidProtonAppVersion('external-drive-protonlfscli@v0.1.2')).toBe(false);
    expect(isValidProtonAppVersion('external-drive-protonlfscli@0.1')).toBe(false);
    expect(isValidProtonAppVersion('external-drive-protonlfscli@0.1.2-rc1')).toBe(false);
    expect(isValidProtonAppVersion('external-drive-ProtonLFS@0.1.2')).toBe(false);
  });

  test('pins the vendored SDK release that is actually checked out', () => {
    expect(VENDORED_DRIVE_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    const sdkDir = path.resolve(__dirname, '..', 'submodules', 'sdk');
    if (!existsSync(path.join(sdkDir, 'client', 'js', 'package.json'))) {
      return; // packaged install without the submodule checkout
    }
    let tags: string[];
    try {
      tags = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'js/v*'], {
        cwd: sdkDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('\n').filter(Boolean);
    } catch {
      return; // not a git checkout (e.g. exported tarball)
    }
    if (tags.length === 0) {
      return; // shallow clone without tags (CI) or an untagged commit
    }
    expect(tags).toContain(`js/v${VENDORED_DRIVE_SDK_VERSION}`);
  });

  test('uses a trimmed environment override', () => {
    process.env.PROTON_DRIVE_CLI_APP_VERSION = ' external-drive-custom@9.9.9 ';

    expect(getProtonAppVersion()).toBe('external-drive-custom@9.9.9');
  });

  test('throws before network calls when an override is invalid', () => {
    process.env.PROTON_DRIVE_CLI_APP_VERSION = 'external-drive-custom-debug@9.9.9';

    expect(() => getProtonAppVersion()).toThrow(
      'Invalid Proton app version "external-drive-custom-debug@9.9.9"'
    );
  });
});
