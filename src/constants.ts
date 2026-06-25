/** Credential host for git credential fill/approve/reject and Proton Pass URL matching. */
export const PROTON_CREDENTIAL_HOST = 'proton.me';

/** Separate credential host/key for two-password mailbox/data password entries. */
export const PROTON_DATA_CREDENTIAL_HOST = 'proton-data.proton-lfs-cli.local';

/** Separate credential host/key for browser-fork derived user key passwords. */
export const PROTON_KEY_PASSWORD_CREDENTIAL_HOST = 'proton-drive-key.proton-lfs-cli.local';

/**
 * Third-party Proton Drive API client identifier.
 *
 * The official SDK CLI builds values like `external-drive-sdkclijs@<version>`.
 * Proton validates the section before `@` as two or three dash-separated
 * lowercase alphanumeric parts. Keep the project section dash-free so
 * auth-info requests do not fail with "Invalid section name".
 */
export const DEFAULT_PROTON_APP_VERSION = 'external-drive-protonlfscli@0.1.2';

const PROTON_APP_VERSION_PATTERN = /^[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)?@[^@\s]+$/;

export function isValidProtonAppVersion(appVersion: string): boolean {
  return PROTON_APP_VERSION_PATTERN.test(appVersion);
}

export function assertValidProtonAppVersion(appVersion: string): string {
  if (isValidProtonAppVersion(appVersion)) {
    return appVersion;
  }

  throw new Error(
    `Invalid Proton app version "${appVersion}". Expected a value like ` +
      '"external-drive-sdkclijs@0.1.2": two or three lowercase alphanumeric ' +
      'dash-separated name parts, followed by @version.'
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
