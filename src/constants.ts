/** Credential host for git credential fill/approve/reject and Proton Pass URL matching. */
export const PROTON_CREDENTIAL_HOST = 'proton.me';

/** Separate credential host/key for two-password mailbox/data password entries. */
export const PROTON_DATA_CREDENTIAL_HOST = 'proton-data.proton-lfs-cli.local';

/** Third-party Proton Drive API client identifier. */
export const DEFAULT_PROTON_APP_VERSION = 'external-drive-proton-lfs-cli@0.1.2';

/**
 * Resolve the Proton API app version header.
 *
 * rclone's Proton Drive backend documents the external client convention as
 * external-drive-<project>@<version>. Keep this value centralized so auth,
 * user, and SDK requests identify consistently.
 */
export function getProtonAppVersion(override?: string): string {
  const candidate = override?.trim() || process.env.PROTON_DRIVE_CLI_APP_VERSION?.trim();
  return candidate || DEFAULT_PROTON_APP_VERSION;
}
