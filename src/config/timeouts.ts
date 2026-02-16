/**
 * Configurable timeout settings for various operations
 *
 * All values can be overridden via environment variables:
 * - PROTON_DRIVE_AUTH_TIMEOUT_MS
 * - PROTON_DRIVE_UPLOAD_TIMEOUT_MS
 * - PROTON_DRIVE_DOWNLOAD_TIMEOUT_MS
 * - PROTON_DRIVE_LIST_TIMEOUT_MS
 * - PROTON_DRIVE_API_TIMEOUT_MS
 */

export interface TimeoutConfig {
  /** Authentication operations (SRP, token refresh) */
  authMs: number;

  /** File upload operations (per file) */
  uploadMs: number;

  /** File download operations (per file) */
  downloadMs: number;

  /** Directory listing operations */
  listMs: number;

  /** Generic API calls */
  apiMs: number;
}

/**
 * Default timeout values (in milliseconds)
 */
export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  authMs: 30000,      // 30 seconds for auth operations
  uploadMs: 300000,   // 5 minutes for uploads
  downloadMs: 300000, // 5 minutes for downloads
  listMs: 30000,      // 30 seconds for listing
  apiMs: 30000,       // 30 seconds for API calls
};

/**
 * Load timeout configuration from environment variables with fallbacks
 */
export function loadTimeoutConfig(): TimeoutConfig {
  return {
    authMs: parseTimeout('PROTON_DRIVE_AUTH_TIMEOUT_MS', DEFAULT_TIMEOUTS.authMs),
    uploadMs: parseTimeout('PROTON_DRIVE_UPLOAD_TIMEOUT_MS', DEFAULT_TIMEOUTS.uploadMs),
    downloadMs: parseTimeout('PROTON_DRIVE_DOWNLOAD_TIMEOUT_MS', DEFAULT_TIMEOUTS.downloadMs),
    listMs: parseTimeout('PROTON_DRIVE_LIST_TIMEOUT_MS', DEFAULT_TIMEOUTS.listMs),
    apiMs: parseTimeout('PROTON_DRIVE_API_TIMEOUT_MS', DEFAULT_TIMEOUTS.apiMs),
  };
}

/**
 * Parse timeout value from environment variable with validation
 */
function parseTimeout(envVar: string, defaultValue: number): number {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid timeout value for ${envVar}: ${value}, using default: ${defaultValue}ms`);
    return defaultValue;
  }

  // Enforce reasonable limits (max 10 minutes)
  const MAX_TIMEOUT_MS = 10 * 60 * 1000;
  if (parsed > MAX_TIMEOUT_MS) {
    console.warn(`Timeout value for ${envVar} exceeds maximum (${MAX_TIMEOUT_MS}ms), capping at max`);
    return MAX_TIMEOUT_MS;
  }

  return parsed;
}

/**
 * Singleton instance of timeout configuration
 */
let timeoutConfig: TimeoutConfig | null = null;

/**
 * Get the current timeout configuration (loads from env on first call)
 */
export function getTimeoutConfig(): TimeoutConfig {
  if (!timeoutConfig) {
    timeoutConfig = loadTimeoutConfig();
  }
  return timeoutConfig;
}

/**
 * Reset timeout configuration (useful for testing)
 */
export function resetTimeoutConfig(): void {
  timeoutConfig = null;
}

/**
 * Create an AbortSignal that times out after the specified duration
 * @param timeoutMs - Timeout in milliseconds
 * @returns AbortSignal that will abort after timeout
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
  return controller.signal;
}

/**
 * Wrap an operation with a timeout
 * @param operation - Async operation to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name for error messages
 * @returns Result of the operation
 * @throws Error if operation times out
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  operationName: string = 'Operation'
): Promise<T> {
  return Promise.race([
    operation(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}
