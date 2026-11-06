/**
 * Shared validators and types for the Git LFS bridge protocol.
 *
 * This module has no transitive dependencies on chalk, the Drive client,
 * AuthService or other heavy modules: only errors/types, errors/classify
 * (which adds the SDK error classes) and bridge/protocol.
 */

import { AppError, ErrorCode } from '../errors/types';
import { toAppError } from '../errors/classify';
import {
  BRIDGE_COMMAND_REQUEST_FIELDS,
  BRIDGE_REQUEST_FIELDS,
  statusCodeForErrorCode,
  type BridgeCommand,
  type BridgeRequestField,
} from './protocol';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Bridge request payload from stdin
 */
export interface BridgeRequest {
  dataCredentialProvider?: string;
  dataCredentialHost?: string;
  appVersion?: string;
  oid?: string;
  path?: string;
  outputPath?: string;
  folder?: string;
  storageBase?: string;
  /** Array of OIDs for batch operations (batch-exists, batch-delete) */
  oids?: string[];
}

/**
 * Bridge response envelope (schemas/bridge/v1/response-envelope.schema.json)
 */
export interface BridgeResponse {
  ok: boolean;
  payload?: unknown;
  error?: string;
  code?: number;
  /** JSON-encoded object described by schemas/bridge/v1/error-details.schema.json */
  details?: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Canonical regex for 64-character hex Git LFS OIDs */
export const OID_PATTERN = /^[a-f0-9]{64}$/i;

/** A request that fails validation: reported as HTTP 400 / VALIDATION_ERROR. */
export function invalidRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, {}, false);
}

// ─── Validators ──────────────────────────────────────────────────

/**
 * Validate OID format (64-character hex string)
 */
export function validateOid(oid: string): void {
  if (!oid || typeof oid !== 'string') {
    throw invalidRequest('OID is required');
  }
  if (!OID_PATTERN.test(oid)) {
    throw invalidRequest('Invalid OID format: expected 64-character hex string');
  }
}

/**
 * Validate that a local file path doesn't contain traversal attempts
 */
export function validateLocalPath(filePath: string): void {
  if (!filePath || typeof filePath !== 'string') {
    throw invalidRequest('File path is required');
  }
  if (filePath.indexOf('\0') !== -1) {
    throw invalidRequest('Null bytes not allowed in path');
  }
  if (filePath.split(/[/\\]/).includes('..')) {
    throw invalidRequest('Path traversal not allowed');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
    throw invalidRequest('Bridge request must be a JSON object');
  }

  const allowedFields = new Set<string>(BRIDGE_COMMAND_REQUEST_FIELDS[command].allowed);
  const knownFields = new Set<string>(BRIDGE_REQUEST_FIELDS);

  for (const field of Object.keys(request)) {
    if (!knownFields.has(field)) {
      throw invalidRequest(`Unknown bridge request field "${field}"`);
    }
    if (!allowedFields.has(field)) {
      throw invalidRequest(`Field "${field}" is not allowed for bridge ${command}`);
    }

    const value = request[field];
    if (value === undefined) continue;
    if ((field as BridgeRequestField) === 'oids') {
      if (!isStringArray(value)) {
        throw invalidRequest(`Field "${field}" must be an array of strings`);
      }
    } else if (typeof value !== 'string') {
      throw invalidRequest(`Field "${field}" must be a string`);
    }
  }

  for (const field of BRIDGE_COMMAND_REQUEST_FIELDS[command].required) {
    const value = request[field];
    if (value === undefined || value === null || value === '') {
      throw invalidRequest(`Field "${field}" is required for bridge ${command}`);
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
    throw invalidRequest(`Invalid OID: must be at least 2 characters, got: ${oid}`);
  }
  if (!OID_PATTERN.test(oid)) {
    throw invalidRequest(`Invalid OID format: expected 64-character hex string, got: ${oid}`);
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
    throw invalidRequest(`Invalid OID path format: ${filePath}`);
  }
  const oid = parts[3];
  if (!OID_PATTERN.test(oid)) {
    throw invalidRequest(`Invalid OID reconstructed from path: ${oid}`);
  }
  return oid.toLowerCase();
}

// ─── Error Mapping ───────────────────────────────────────────────

/**
 * Map any error to the bridge HTTP status code.
 *
 * The error is first classified into an AppError (errors/classify), then the
 * AppError code is looked up in ERROR_CODE_STATUS, so the status and the
 * `details.errorCode` reported to the Go adapter always agree.
 */
export function errorToStatusCode(error: unknown): number {
  return statusCodeForErrorCode(toAppError(error).code) ?? 500;
}
