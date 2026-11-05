import { version as pkgVersion } from '../package.json';

/** Credential host for git credential fill/approve/reject and Proton Pass URL matching. */
export const PROTON_CREDENTIAL_HOST = 'proton.me';

/** Separate credential host/key for two-password mailbox/data password entries. */
export const PROTON_DATA_CREDENTIAL_HOST = 'proton-data.proton-lfs-cli.local';

/** Separate credential host/key for browser-fork derived user key passwords. */
export const PROTON_KEY_PASSWORD_CREDENTIAL_HOST = 'proton-drive-key.proton-lfs-cli.local';

/**
 * Third-party Proton Drive API client identifier (`x-pm-appversion`).
 *
 * The official SDK README ("Identify your application") requires third-party
 * clients to use `external-drive-{name}@{semver}[-{channel}][+{suffix}]`:
 *   - `{name}`: lowercase letters and underscores (dash-free, so Proton's
 *     section-name validation sees exactly `external`, `drive`, `{name}`)
 *   - `{semver}`: `major.minor.patch`
 *   - optional `{channel}`: `stable`, `beta` or `alpha`
 *   - optional `+{suffix}`: SemVer build metadata such as a short commit hash
 * Examples: `external-drive-myapp@1.2.3-stable`, `external-drive-my_app@2.0.0-beta`.
 *
 * `cli-drive` is reserved for Proton's official CLI builds and is rejected
 * here on purpose: third-party clients must never masquerade as first-party.
 *
 * The version part follows package.json so the identity cannot drift from
 * the published CLI version.
 */
/**
 * Release of the vendored Proton Drive SDK (`submodules/sdk`, tag `js/v<version>`).
 *
 * The SDK's own package.json carries a `0.0.1` placeholder that Proton only
 * replaces when publishing to npm, so the SDK would otherwise announce
 * `js@0.0.1` in `x-pm-drive-sdk-version`. Bump together with the submodule;
 * constants.test.ts checks it against the checked-out tag.
 */
export const VENDORED_DRIVE_SDK_VERSION = '0.23.0';

export const PROTON_APP_NAME = 'protonlfscli';
export const DEFAULT_PROTON_APP_VERSION = `external-drive-${PROTON_APP_NAME}@${pkgVersion}`;

const PROTON_APP_VERSION_PATTERN =
  /^external-drive-[a-z_]+@\d+\.\d+\.\d+(?:-(?:stable|beta|alpha))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isValidProtonAppVersion(appVersion: string): boolean {
  return PROTON_APP_VERSION_PATTERN.test(appVersion);
}

export function assertValidProtonAppVersion(appVersion: string): string {
  if (isValidProtonAppVersion(appVersion)) {
    return appVersion;
  }

  throw new Error(
    `Invalid Proton app version "${appVersion}". Expected the third-party ` +
      'format "external-drive-{name}@{major.minor.patch}[-stable|beta|alpha][+build]" ' +
      'with {name} in lowercase letters/underscores, e.g. "external-drive-protonlfscli@0.1.2".'
  );
}

/**
 * Resolve the Proton API app version header.
 *
 * Keep this value centralized so auth, user, and SDK requests identify
 * consistently and fail locally if an override would be rejected by Proton.
 */
export function getProtonAppVersion(override?: string): string {
  const candidate = override?.trim() || process.env.PROTON_DRIVE_CLI_APP_VERSION?.trim();
  return assertValidProtonAppVersion(candidate || DEFAULT_PROTON_APP_VERSION);
}
