import {
  DEFAULT_PROTON_APP_VERSION,
  assertValidProtonAppVersion,
  getProtonAppVersion,
  isValidProtonAppVersion,
} from './constants';

describe('Proton app version constants', () => {
  const originalEnv = process.env.PROTON_DRIVE_CLI_APP_VERSION;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PROTON_DRIVE_CLI_APP_VERSION;
    } else {
      process.env.PROTON_DRIVE_CLI_APP_VERSION = originalEnv;
    }
  });

  test('uses an SDK-shaped default app version', () => {
    expect(DEFAULT_PROTON_APP_VERSION).toBe('external-drive-protonlfscli@0.1.2');
    expect(isValidProtonAppVersion(DEFAULT_PROTON_APP_VERSION)).toBe(true);
  });

  test('accepts official and third-party app version sections', () => {
    expect(assertValidProtonAppVersion('cli-drive@1.2.3')).toBe('cli-drive@1.2.3');
    expect(assertValidProtonAppVersion('external-drive-sdkclijs@0.0.0')).toBe(
      'external-drive-sdkclijs@0.0.0'
    );
  });

  test('rejects app version sections with extra dash-separated parts', () => {
    expect(isValidProtonAppVersion('external-drive-proton-lfs-cli@0.1.2')).toBe(false);
    expect(() => assertValidProtonAppVersion('external-drive-proton-lfs-cli@0.1.2'))
      .toThrow('Invalid Proton app version');
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
