/**
 * Shared validators and types for the Git LFS bridge protocol.
 *
 * This module has NO transitive dependencies on chalk, DriveClient,
 * AuthService, or any other heavy module — only on errors/types.ts
 * (which itself has zero imports).
 */

import { ErrorCode } from '../errors/types';
import {
  ProtonDriveError,
  ValidationError,
  ServerError,
  RateLimitedError,
  ConnectionError,
  DecryptionError,
  IntegrityError,
  AbortError,
} from '@protontech/drive-sdk';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Bridge request payload from stdin
 */
export interface BridgeRequest {
  username?: string;
  password?: string;
  dataPassword?: string;
  secondFactorCode?: string;
  appVersion?: string;
  oid?: string;
  path?: string;
  outputPath?: string;
  folder?: string;
  storageBase?: string;
  /** When set to 'git-credential', the bridge resolves credentials itself via git credential fill */
  credentialProvider?: string;
  /** Array of OIDs for batch operations (batch-exists, batch-delete) */
  oids?: string[];
}

/**
 * Bridge response envelope
 */
export interface BridgeResponse {
  ok: boolean;
  payload?: any;
  error?: string;
  code?: number;
  details?: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Canonical regex for 64-character hex Git LFS OIDs */
export const OID_PATTERN = /^[a-f0-9]{64}$/i;

// ─── Validators ──────────────────────────────────────────────────

/**
 * Validate OID format (64-character hex string)
 */
export function validateOid(oid: string): void {
  if (!oid || typeof oid !== 'string') {
    throw new Error('OID is required');
  }
  if (!OID_PATTERN.test(oid)) {
    throw new Error('Invalid OID format: expected 64-character hex string');
  }
}

/**
 * Validate that a local file path doesn't contain traversal attempts
 */
export function validateLocalPath(filePath: string): void {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path is required');
  }
  if (filePath.indexOf('\0') !== -1) {
    throw new Error('Null bytes not allowed in path');
  }
  if (filePath.split(/[/\\]/).includes('..')) {
    throw new Error('Path traversal not allowed');
  }
}

// ─── OID Path Mapping ────────────────────────────────────────────

/**
 * Convert Git LFS OID to Proton Drive path.
 * Uses 2-level prefix directories matching Git LFS spec: OID[0:2]/OID[2:4]/OID
 *
 * @example oidToPath("LFS", "4d7a2146...64chars") => "/LFS/4d/7a/4d7a2146...64chars"
 */
export function oidToPath(storageBase: string, oid: string): string {
  if (!oid || oid.length < 2) {
    throw new Error(`Invalid OID: must be at least 2 characters, got: ${oid}`);
  }
  if (!OID_PATTERN.test(oid)) {
    throw new Error(`Invalid OID format: expected 64-character hex string, got: ${oid}`);
  }

  const normalizedBase = storageBase.replace(/^\/+|\/+$/g, '');
  const prefix = oid.substring(0, 2).toLowerCase();
  const second = oid.substring(2, 4).toLowerCase();
  const fullOid = oid.toLowerCase();
  return `/${normalizedBase}/${prefix}/${second}/${fullOid}`;
}

/**
 * Extract OID from Proton Drive path (reverses oidToPath).
 *
 * @example pathToOid("/LFS/4d/7a/4d7a2146...") => "4d7a2146..."
 */
export function pathToOid(filePath: string): string {
  const parts = filePath.replace(/^\/+/, '').split('/');
  if (parts.length < 4) {
    throw new Error(`Invalid OID path format: ${filePath}`);
  }
  const oid = parts[3];
  if (!OID_PATTERN.test(oid)) {
    throw new Error(`Invalid OID reconstructed from path: ${oid}`);
  }
  return oid.toLowerCase();
}

// ─── Error Mapping ───────────────────────────────────────────────

/**
 * Map error to HTTP status code.
 *
 * Checks in order:
 * 1. SDK error types (ProtonDriveError subclasses)
 * 2. Our AppError codes (ErrorCode enum)
 * 3. Message string patterns (fallback)
 */
export function errorToStatusCode(error: any): number {
  // SDK error types — checked first so they're never misclassified by string matching
  if (error instanceof RateLimitedError) return 429;
  if (error instanceof ValidationError) return 400;
  if (error instanceof ConnectionError) return 502;
  if (error instanceof ServerError) return 502;
  if (error instanceof DecryptionError) return 500;
  if (error instanceof IntegrityError) return 500;
  if (error instanceof AbortError) return 499;

  const code = error?.code;
  if (code === ErrorCode.AUTH_FAILED || code === ErrorCode.INVALID_CREDENTIALS) return 401;
  if (code === ErrorCode.SESSION_EXPIRED) return 401;
  if (code === ErrorCode.TWO_FACTOR_REQUIRED) return 401;
  if (code === ErrorCode.NOT_FOUND || code === ErrorCode.PATH_NOT_FOUND || code === ErrorCode.FILE_NOT_FOUND) return 404;
  if (code === ErrorCode.INVALID_FILE || code === ErrorCode.VALIDATION_ERROR || code === ErrorCode.INVALID_PATH || code === ErrorCode.NOT_A_FOLDER) return 400;
  if (code === ErrorCode.PERMISSION_DENIED) return 403;
  if (code === ErrorCode.FILE_TOO_LARGE) return 413;
  if (code === ErrorCode.RATE_LIMITED) return 429;
  if (code === ErrorCode.CAPTCHA_REQUIRED) return 407;
  if (code === ErrorCode.OPERATION_CANCELLED) return 499;
  if (code === ErrorCode.TIMEOUT) return 504;
  if (code === ErrorCode.QUOTA_EXCEEDED || code === ErrorCode.DISK_FULL) return 507;
  if (code === ErrorCode.NETWORK_ERROR || code === ErrorCode.CONNECTION_REFUSED || code === ErrorCode.API_ERROR) return 502;
  if (code === ErrorCode.UPLOAD_FAILED || code === ErrorCode.DOWNLOAD_FAILED) return 502;
  if (code === ErrorCode.ENCRYPTION_FAILED || code === ErrorCode.DECRYPTION_FAILED) return 500;

  const msg = error?.message?.toLowerCase() || '';
  if (msg.includes('not found')) return 404;
  if (msg.includes('unauthorized') || msg.includes('login failed')) return 401;
  if (msg.includes('invalid')) return 400;
  if (msg.includes('captcha')) return 407;
  return 500;
}
