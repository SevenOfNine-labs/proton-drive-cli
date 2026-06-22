/**
 * Shared validators and types for the Git LFS bridge protocol.
 *
 * This module has NO transitive dependencies on chalk, DriveClient,
 * AuthService, or any other heavy module — only on errors/types.ts
 * (which itself has zero imports).
 */

import {
  BRIDGE_COMMAND_REQUEST_FIELDS,
  BRIDGE_REQUEST_FIELDS,
  statusCodeForErrorCode,
  type BridgeCommand,
  type BridgeRequestField,
} from './protocol';
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
  dataCredentialProvider?: string;
  dataCredentialHost?: string;
  secondFactorCode?: string;
  appVersion?: string;
  oid?: string;
  path?: string;
  outputPath?: string;
  folder?: string;
  storageBase?: string;
  /** When set to 'git-credential', the bridge resolves credentials itself via git credential fill */
  credentialProvider?: string;
  /** Explicitly controls whether SDK initialization may perform full SRP login */
  allowLogin?: boolean;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestFieldType(field: BridgeRequestField): 'string' | 'boolean' | 'string-array' {
  if (field === 'allowLogin') return 'boolean';
  if (field === 'oids') return 'string-array';
  return 'string';
}

/**
 * Validate the JSON request envelope for a specific bridge command.
 *
 * This enforces the canonical command/field matrix before any command can
 * resolve credentials, touch the network, or perform local file operations.
 * Format-specific checks such as OID syntax and path traversal remain in the
 * command handlers so their existing error messages stay stable.
 */
export function validateBridgeRequestForCommand(
  command: BridgeCommand,
  request: unknown,
): asserts request is BridgeRequest {
  if (!isPlainObject(request)) {
    throw new Error('Bridge request must be a JSON object');
  }

  const allowedFields = new Set(BRIDGE_COMMAND_REQUEST_FIELDS[command].allowed);
  const knownFields = new Set(BRIDGE_REQUEST_FIELDS);

  for (const field of Object.keys(request)) {
    if (!knownFields.has(field as BridgeRequestField)) {
      throw new Error(`Unknown bridge request field "${field}"`);
    }
    if (!allowedFields.has(field as BridgeRequestField)) {
      throw new Error(`Field "${field}" is not allowed for bridge ${command}`);
    }

    const value = request[field];
    const expectedType = requestFieldType(field as BridgeRequestField);
    if (value === undefined) continue;
    if (expectedType === 'string' && typeof value !== 'string') {
      throw new Error(`Field "${field}" must be a string`);
    }
    if (expectedType === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`Field "${field}" must be a boolean`);
    }
    if (expectedType === 'string-array') {
      if (!Array.isArray(value)) {
        throw new Error(`Field "${field}" must be an array of strings`);
      }
      if (!value.every((item) => typeof item === 'string')) {
        throw new Error(`Field "${field}" must be an array of strings`);
      }
    }
  }

  for (const field of BRIDGE_COMMAND_REQUEST_FIELDS[command].required) {
    const value = request[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Field "${field}" is required for bridge ${command}`);
    }
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

  const mappedStatus = statusCodeForErrorCode(error?.code);
  if (mappedStatus !== undefined) return mappedStatus;

  const msg = error?.message?.toLowerCase() || '';
  if (msg.includes('not found')) return 404;
  if (msg.includes('unauthorized') || msg.includes('login failed')) return 401;
  if (msg.includes('invalid')) return 400;
  if (msg.includes('captcha')) return 407;
  return 500;
}
