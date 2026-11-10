// `proton-drive-cli bridge <command>`: one JSON request on stdin, one JSON
// envelope on stdout, logs on stderr (contract: schemas/bridge/v1). Drive
// operations use the saved browser-fork session; the bridge never logs in.

import { Command } from 'commander';
import * as fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Readable, Writable } from 'stream';
import { text } from 'stream/consumers';
import { finished } from 'stream/promises';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { createSDKClient } from '../sdk/client';
import { ensureFolderPath, findFileNodeInFolder } from '../sdk/pathResolver';
import { SessionManager } from '../auth/session';
import { createSessionSecretStore } from '../auth/session-secrets';
import { AppError, ErrorCode, CaptchaError } from '../errors/types';
import { toAppError } from '../errors/classify';
import { redactSensitive } from '../utils/redaction';
import { logger, LogLevel } from '../utils/logger';
import {
  deleteByOid,
  findFileByOid,
  listFolder,
  oidFileLocation,
  type ListItem,
} from './bridge-helpers';
import {
  BridgeRequest,
  BridgeResponse,
  invalidRequest,
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
} from '../bridge/validators';
import {
  isBridgeCommand,
  statusCodeForErrorCode,
  type BridgeAuthState,
  type BridgeCommand,
} from '../bridge/protocol';
import { createRetryConfig, retryWithBackoff, type RetryConfig } from '../utils/retry';

export { BridgeRequest, BridgeResponse, validateOid, validateLocalPath, validateBridgeRequestForCommand, errorToStatusCode } from '../bridge/validators';
export type { BridgeAuthState } from '../bridge/protocol';

const DEFAULT_STORAGE_BASE = 'LFS';

/** The calling process must close stdin; this bounds a caller that never does. */
const STDIN_TIMEOUT_MS = 30_000;

// ─── Envelope ──────────────────────────────────────────────────────

/**
 * Write the single JSON envelope to stdout.
 */
export function writeResponse(response: BridgeResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function success(payload: object): BridgeResponse {
  return { ok: true, payload };
}

export function formatCaptchaError(error: CaptchaError): BridgeResponse {
  return {
    ok: false,
    error: 'CAPTCHA verification required — run: proton-drive-cli login',
    code: statusCodeForErrorCode(ErrorCode.CAPTCHA_REQUIRED),
    details: JSON.stringify({
      errorCode: ErrorCode.CAPTCHA_REQUIRED,
      captchaUrl: error.captchaUrl,
      captchaToken: error.captchaToken,
      verificationMethods: error.verificationMethods,
      action: 'run: proton-drive-cli login',
    }),
  };
}

export function formatInsufficientScopeError(error: unknown): BridgeResponse {
  const message = error instanceof Error && error.message
    ? error.message
    : 'Access token does not have sufficient Proton scope';

  return {
    ok: false,
    error: message,
    code: statusCodeForErrorCode(ErrorCode.INSUFFICIENT_SCOPE),
    details: JSON.stringify({
      errorCode: ErrorCode.INSUFFICIENT_SCOPE,
      protonCode: 9101,
      action: 'stop: app/session scope is insufficient; do not retry login loops',
    }),
  };
}

/**
 * Build the failure envelope for any error.
 *
 * The error is classified once (errors/classify); the HTTP `code` comes from
 * the AppError code (bridge/protocol ERROR_CODE_STATUS) and `details` always
 * carries the same code as `errorCode` plus the redacted AppError details, so
 * the Go adapter can classify every failure structurally.
 */
export function toBridgeErrorResponse(error: unknown, fallbackMessage = 'Operation failed'): BridgeResponse {
  const appError = toAppError(error);

  if (appError instanceof CaptchaError) {
    return formatCaptchaError(appError);
  }
  if (appError.code === ErrorCode.INSUFFICIENT_SCOPE) {
    return formatInsufficientScopeError(appError);
  }

  const details: Record<string, unknown> = {
    ...(redactSensitive(appError.details ?? {}) as Record<string, unknown>),
    errorCode: appError.code,
  };

  let message = appError.message || fallbackMessage;
  if (appError.code === ErrorCode.RATE_LIMITED) {
    message = typeof details.retryAfter === 'number'
      ? `Rate limited by Proton API — wait ${details.retryAfter}s and retry`
      : 'Rate limited by Proton API — wait and retry';
  }

  return {
    ok: false,
    error: message,
    code: statusCodeForErrorCode(appError.code) ?? 500,
    details: JSON.stringify(details),
  };
}

// ─── Request input ─────────────────────────────────────────────────

/**
 * Read the whole of stdin and parse it as JSON.
 */
async function readStdinJson(): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      process.stdin.destroy();
      reject(invalidRequest(`Timed out waiting for stdin input (${STDIN_TIMEOUT_MS}ms)`));
    }, STDIN_TIMEOUT_MS);
  });
  const body = text(process.stdin);
  body.catch(() => undefined);

  let input: string;
  try {
    input = await Promise.race([body, timeout]);
  } finally {
    clearTimeout(timer);
  }

  if (!input.trim()) {
    throw invalidRequest('Empty input received');
  }
  try {
    return JSON.parse(input);
  } catch (error) {
    throw invalidRequest(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireField(request: BridgeRequest, field: 'oid' | 'path' | 'outputPath'): string {
  const value = request[field];
  if (!value) {
    throw invalidRequest(`Field "${field}" is required`);
  }
  return value;
}

function requireOids(request: BridgeRequest, command: BridgeCommand): string[] {
  const { oids } = request;
  if (!oids || !Array.isArray(oids) || oids.length === 0) {
    throw invalidRequest(`oids array is required for ${command}`);
  }
  for (const oid of oids) {
    validateOid(oid);
  }
  return oids;
}

// ─── auth-state ────────────────────────────────────────────────────

export interface BridgeAuthStatePayload {
  state: BridgeAuthState;
  hasSession: boolean;
  sessionValid: boolean;
  sessionExpired: boolean;
  sessionUidPresent: boolean;
  credentialsAvailable: boolean;
  credentialStore?: string;
  credentialHost?: string;
  willAttemptNetwork: false;
  errors: string[];
  actions: string[];
}

const LOGIN_ACTION = 'Run proton-drive-cli login to complete browser sign-in before transfers.';

/**
 * Inspect bridge auth readiness without sending a request to the Proton API
 * and without refreshing tokens: reads session.json, applies the local
 * expiry check and reads the session's entry from its credential store
 * (pass-cli can contact Proton Pass to do so).
 */
export async function getBridgeAuthState(sessionFile?: string): Promise<BridgeAuthStatePayload> {
  const stored = await SessionManager.readStoredSession(sessionFile);
  const session = stored.kind === 'valid' ? stored.record : null;
  const sessionValid = session ? await SessionManager.validateSession(session) : false;
  const errors: string[] = [];
  const actions: string[] = [];

  let credentialsAvailable = false;
  if (session) {
    try {
      await createSessionSecretStore({ store: session.credentialStore, host: session.credentialHost }).load(session.uid);
      credentialsAvailable = true;
    } catch (error) {
      errors.push(`Credentials unavailable from ${session.credentialStore}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let state: BridgeAuthState;
  if (stored.kind === 'none') {
    state = 'needs_login';
    actions.push(LOGIN_ACTION);
  } else if (stored.kind === 'invalid') {
    state = 'session_invalid';
    actions.push('The saved session is not a proton-drive-cli login session. ' + LOGIN_ACTION);
  } else if (!credentialsAvailable) {
    state = 'credentials_unavailable';
    actions.push('Fix the credential store of the saved session (see errors), or run proton-drive-cli login.');
  } else if (!sessionValid) {
    state = 'session_expired';
    actions.push('Transfers refresh the access token before use (bridge init); auth-state did not refresh it.');
  } else {
    state = 'ready';
    actions.push('Local auth inputs are sufficient for SDK initialization; auth-state sent no request to the Proton API.');
  }

  return {
    state,
    hasSession: stored.kind !== 'none',
    sessionValid,
    sessionExpired: session !== null && !sessionValid,
    sessionUidPresent: session !== null,
    credentialsAvailable,
    credentialStore: session?.credentialStore,
    credentialHost: session?.credentialHost,
    willAttemptNetwork: false,
    errors,
    actions,
  };
}

// ─── Drive client and transfers ────────────────────────────────────

/**
 * Initialize ProtonDriveClient (SDK) from the saved browser-fork session,
 * unlocked with the stored key password; the bridge never logs in.
 */
export async function getInitializedClient(request: BridgeRequest): Promise<ProtonDriveClient> {
  return createSDKClient({ appVersion: request.appVersion });
}

function normalizeStorageBase(storageBase: string): string {
  return storageBase.replace(/^\/+|\/+$/g, '');
}

export const BRIDGE_TRANSFER_RETRY_CONFIG = createRetryConfig({
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 5_000,
});

export interface UploadedFile {
  nodeUid: string;
  nodeRevisionUid: string;
}

export async function uploadFileWithRetry(
  client: ProtonDriveClient,
  parentUid: string,
  fileName: string,
  filePath: string,
  expectedSize: number,
  retryConfig: RetryConfig = BRIDGE_TRANSFER_RETRY_CONFIG,
  context = `Bridge upload ${fileName}`
): Promise<UploadedFile> {
  return retryWithBackoff(async () => {
    const fileStream = createReadStream(filePath);
    try {
      const webStream = Readable.toWeb(fileStream) as ReadableStream;
      const uploader = await client.getFileUploader(parentUid, fileName, {
        mediaType: 'application/octet-stream',
        expectedSize,
      });
      const ctrl = await uploader.uploadFromStream(webStream, []);
      const { nodeUid, nodeRevisionUid } = await ctrl.completion();
      return { nodeUid, nodeRevisionUid };
    } catch (error) {
      fileStream.destroy();
      throw error;
    }
  }, retryConfig, context);
}

/**
 * Download a node to `outputPath` and return the written size.
 *
 * The file is created with mode 0600 so a retry after a failed attempt never
 * recreates it with the process umask (CWE-732). The write stream is ended
 * and awaited before the size is read, so the reported size is the flushed
 * size.
 */
export async function downloadFileWithRetry(
  client: ProtonDriveClient,
  nodeUid: string,
  outputPath: string,
  retryConfig: RetryConfig = BRIDGE_TRANSFER_RETRY_CONFIG,
  context = `Bridge download ${nodeUid}`
): Promise<number> {
  await retryWithBackoff(async () => {
    const fileStream = createWriteStream(outputPath, { mode: 0o600 });
    try {
      const webStream = Writable.toWeb(fileStream) as WritableStream;
      const downloader = await client.getFileDownloader(nodeUid);
      const ctrl = downloader.downloadToStream(webStream);
      await ctrl.completion();
      if (!fileStream.writableEnded) {
        fileStream.end();
      }
      await finished(fileStream);
    } catch (error) {
      fileStream.destroy();
      await fs.rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }, retryConfig, context);

  const stat = await fs.stat(outputPath);
  return stat.size;
}

// ─── Command payloads (schemas/bridge/v1/payloads/<command>.schema.json) ──

export interface BridgeUploadPayload {
  oid: string;
  fileId: string;
  revisionId: string;
  uploaded: boolean;
  deduplicated: boolean;
}

export interface BridgeDownloadPayload {
  oid: string;
  outputPath: string;
  size: number;
  downloaded: true;
}

export interface BridgeListPayload {
  files: ListItem[];
}

export interface BridgeExistsPayload {
  oid: string;
  exists: boolean;
}

export interface BridgeDeletePayload {
  oid: string;
  deleted: true;
}

export interface BridgeInitPayload {
  storageBase: string;
  path: string;
  initialized: true;
}

export interface BridgeBatchResultPayload {
  results: Record<string, boolean>;
}

// ─── Command handlers ──────────────────────────────────────────────

function fileNotFound(oid: string): AppError {
  return new AppError(`File not found for OID: ${oid}`, ErrorCode.FILE_NOT_FOUND, { oid }, false);
}

async function handleUpload(request: BridgeRequest): Promise<BridgeUploadPayload> {
  const oid = requireField(request, 'oid');
  const filePath = requireField(request, 'path');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;

  validateOid(oid);
  validateLocalPath(filePath);
  const stat = await fs.stat(filePath);

  const client = await getInitializedClient(request);
  const { folderPath, fileName } = oidFileLocation(storageBase, oid);
  // One root-to-leaf traversal creates the whole /base/xx/yy chain.
  const parentUid = await ensureFolderPath(client, folderPath);

  const existing = await findFileNodeInFolder(client, parentUid, fileName);
  if (existing) {
    logger.info(`Upload skipped for ${oid} (remote object already exists)`);
    return {
      oid,
      fileId: existing.uid,
      revisionId: existing.activeRevision?.uid ?? '',
      uploaded: false,
      deduplicated: true,
    };
  }

  const { nodeUid, nodeRevisionUid } = await uploadFileWithRetry(
    client,
    parentUid,
    fileName,
    filePath,
    stat.size,
    BRIDGE_TRANSFER_RETRY_CONFIG,
    `Bridge upload ${oid}`
  );

  return {
    oid,
    fileId: nodeUid,
    revisionId: nodeRevisionUid,
    uploaded: true,
    deduplicated: false,
  };
}

async function handleDownload(request: BridgeRequest): Promise<BridgeDownloadPayload> {
  const oid = requireField(request, 'oid');
  const outputPath = requireField(request, 'outputPath');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;

  validateOid(oid);
  validateLocalPath(outputPath);

  const client = await getInitializedClient(request);
  const nodeUid = await findFileByOid(client, storageBase, oid);
  if (!nodeUid) {
    throw fileNotFound(oid);
  }

  const size = await downloadFileWithRetry(
    client,
    nodeUid,
    outputPath,
    BRIDGE_TRANSFER_RETRY_CONFIG,
    `Bridge download ${oid}`
  );

  return { oid, outputPath, size, downloaded: true };
}

async function handleList(request: BridgeRequest): Promise<BridgeListPayload> {
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;
  const client = await getInitializedClient(request);
  const targetFolder = request.folder || `/${storageBase}`;

  const items = await listFolder(client, targetFolder);
  return {
    files: items.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size,
      modifiedTime: item.modifiedTime,
    })),
  };
}

async function handleExists(request: BridgeRequest): Promise<BridgeExistsPayload> {
  const oid = requireField(request, 'oid');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;
  validateOid(oid);

  const client = await getInitializedClient(request);
  const nodeUid = await findFileByOid(client, storageBase, oid);
  return { oid, exists: nodeUid !== null };
}

async function handleDelete(request: BridgeRequest): Promise<BridgeDeletePayload> {
  const oid = requireField(request, 'oid');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;
  validateOid(oid);

  const client = await getInitializedClient(request);
  const deleted = await deleteByOid(client, storageBase, oid);
  if (!deleted) {
    throw fileNotFound(oid);
  }
  return { oid, deleted: true };
}

async function handleInit(request: BridgeRequest): Promise<BridgeInitPayload> {
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;
  const client = await getInitializedClient(request);
  const basePath = `/${normalizeStorageBase(storageBase)}`;
  await ensureFolderPath(client, basePath);
  return { storageBase, path: basePath, initialized: true };
}

async function handleBatchExists(request: BridgeRequest): Promise<BridgeBatchResultPayload> {
  const oids = requireOids(request, 'batch-exists');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;

  const client = await getInitializedClient(request);
  const results: Record<string, boolean> = {};
  for (const oid of oids) {
    results[oid] = (await findFileByOid(client, storageBase, oid)) !== null;
  }
  return { results };
}

async function handleBatchDelete(request: BridgeRequest): Promise<BridgeBatchResultPayload> {
  const oids = requireOids(request, 'batch-delete');
  const storageBase = request.storageBase || DEFAULT_STORAGE_BASE;

  const client = await getInitializedClient(request);
  const results: Record<string, boolean> = {};
  for (const oid of oids) {
    results[oid] = await deleteByOid(client, storageBase, oid);
  }
  return { results };
}

type BridgeHandler = (request: BridgeRequest) => Promise<object>;

const BRIDGE_HANDLERS: Record<BridgeCommand, BridgeHandler> = {
  'auth-state': () => getBridgeAuthState(),
  upload: handleUpload,
  download: handleDownload,
  list: handleList,
  exists: handleExists,
  delete: handleDelete,
  init: handleInit,
  'batch-exists': handleBatchExists,
  'batch-delete': handleBatchDelete,
};

/**
 * Run one bridge command against an already-parsed request and return the
 * envelope to write. Never throws: every failure becomes an error envelope.
 */
export async function runBridgeCommand(commandName: string, request: unknown): Promise<BridgeResponse> {
  const command = commandName.toLowerCase();
  if (!isBridgeCommand(command)) {
    return toBridgeErrorResponse(invalidRequest(`Unknown bridge command: ${commandName}`));
  }

  try {
    validateBridgeRequestForCommand(command, request);
    return success(await BRIDGE_HANDLERS[command](request));
  } catch (error) {
    return toBridgeErrorResponse(error, `Bridge ${command} failed`);
  }
}

// ─── Command registration ──────────────────────────────────────────

/**
 * Create the bridge command for the CLI.
 *
 * Implements the JSON stdin/stdout protocol used by the Go Git LFS adapter.
 *
 * # Commands
 *
 * - **auth-state**: inspect local auth readiness (no Proton API call)
 * - **init**: create the storage base folder
 * - **upload**: store a local file under its OID path (deduplicates existing objects)
 * - **download**: fetch an object by OID into `outputPath`
 * - **exists** / **batch-exists**: check object presence by OID
 * - **delete** / **batch-delete**: remove objects by OID
 * - **list**: list a folder (defaults to the storage base)
 *
 * # Request and response
 *
 * The request is a JSON object on stdin (schemas/bridge/v1/request.schema.json;
 * allowed fields per command in request-field-rules.json). The response is one
 * JSON line on stdout (response-envelope.schema.json) whose `payload` follows
 * schemas/bridge/v1/payloads/<command>.schema.json. Failures carry an HTTP-like
 * `code` and a JSON `details` string with `errorCode`
 * (error-details.schema.json, error-code-map.json).
 *
 * # Exit codes
 *
 * - 0: an envelope was written (inspect `ok`)
 * - 1: the request could not be read from stdin (timeout, empty or invalid JSON);
 *   an error envelope is still written
 *
 * @example
 * ```bash
 * printf '{}\n' | proton-drive-cli bridge auth-state
 * printf '{"oid":"<64 hex>","path":"/tmp/file.bin"}\n' | proton-drive-cli bridge upload
 * printf '{"oids":["<64 hex>","<64 hex>"]}\n' | proton-drive-cli bridge batch-exists
 * ```
 *
 * @category CLI Commands
 * @see {@link runBridgeCommand} for the command dispatcher
 */
export function createBridgeCommand(): Command {
  const cmd = new Command('bridge');

  cmd
    .description(
      'Bridge mode for Git LFS integration — reads JSON from stdin, writes JSON to stdout'
    )
    .argument('<command>', 'Bridge command: auth-state, upload, download, list, exists, delete, init, batch-exists, batch-delete')
    .action(async (command: string) => {
      // stdout carries only the envelope; logs go to stderr at ERROR level
      // unless the caller asked for debug output.
      if (process.env.DEBUG !== 'true') {
        logger.setLevel(LogLevel.ERROR);
      }

      let request: unknown;
      try {
        request = await readStdinJson();
      } catch (error) {
        writeResponse(toBridgeErrorResponse(error, 'Bridge request could not be read'));
        process.exitCode = 1;
        return;
      }

      writeResponse(await runBridgeCommand(command, request));
    });

  return cmd;
}
