/**
 * Bridge command for Git LFS integration
 * Reads JSON from stdin, performs operations, writes JSON to stdout
 * Uses bridge protocol envelope format:
 *   { ok: true/false, payload: {...}, error: "...", code: 400-500 }
 *
 * Uses ProtonDriveClient (official SDK) for all Drive operations.
 */

import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { createSDKClient } from '../sdk/client';
import { ensureFolderPath } from '../sdk/pathResolver';
import { AuthService } from '../auth';
import { SessionManager } from '../auth/session';
import { AppError, ErrorCode, CaptchaError, RateLimitError, isRateLimitError, isCaptchaError } from '../errors/types';
import { logger, LogLevel } from '../utils/logger';
import {
  ensureOidFolder,
  findFileByOid,
  deleteByOid,
  listFolder,
} from './bridge-helpers';
import {
  BridgeRequest,
  BridgeResponse,
  validateOid,
  validateLocalPath,
  errorToStatusCode,
  oidToPath,
} from '../bridge/validators';
import { createProvider, normalizeProviderName } from '../credentials';
import { ChangeTokenCache } from '../drive/change-tokens';

/**
 * Write JSON response to stdout (single line, no extra output)
 */
function writeResponse(response: BridgeResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function writeSuccess(payload: any = {}): void {
  writeResponse({ ok: true, payload });
}

function writeError(message: string, code: number = 500, details: string = ''): void {
  writeResponse({ ok: false, error: message, code, details });
}

/**
 * Centralized error handler for bridge commands.
 * Detects CAPTCHA and rate-limit errors and formats appropriate responses.
 */
function handleBridgeError(error: any, fallbackMessage: string = 'Operation failed'): void {
  // CAPTCHA required (use centralized detection)
  if (isCaptchaError(error)) {
    if (error instanceof CaptchaError) {
      writeResponse(formatCaptchaError(error));
    } else {
      writeError('CAPTCHA verification required — run: proton-drive login', 407);
    }
    return;
  }

  // Rate-limit (use centralized detection)
  if (isRateLimitError(error)) {
    const retryAfter = (error as any).retryAfter;
    const message = retryAfter
      ? `Rate limited by Proton API — wait ${retryAfter}s and retry`
      : 'Rate limited by Proton API — wait and retry';
    writeError(message, 429);
    return;
  }

  // Generic error
  writeError(
    error.message || fallbackMessage,
    errorToStatusCode(error)
  );
}

/**
 * Read JSON payload from stdin.
 * Timeout prevents hanging indefinitely if the calling process never closes stdin.
 */
const STDIN_TIMEOUT_MS = 30_000;

async function readStdinJson(): Promise<BridgeRequest> {
  return new Promise((resolve, reject) => {
    let input = '';
    let settled = false;

    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new Error(`Timed out waiting for stdin input (${STDIN_TIMEOUT_MS}ms)`));
    }, STDIN_TIMEOUT_MS);

    rl.on('line', (line) => {
      input += line;
    });

    rl.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!input.trim()) {
          reject(new Error('Empty input received'));
          return;
        }
        resolve(JSON.parse(input));
      } catch (error: any) {
        reject(new Error(`Failed to parse JSON: ${error.message}`));
      }
    });

    rl.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Re-export validators for existing consumers (e.g., bridge.test.ts)
export { BridgeRequest, BridgeResponse, validateOid, validateLocalPath, errorToStatusCode } from '../bridge/validators';
// formatCaptchaError is exported directly from this module (above)

/**
 * Resolve credentials from request, using the unified credential provider
 * when credentialProvider is set (git-credential, pass-cli, etc.).
 */
async function resolveRequestCredentials(request: BridgeRequest): Promise<{ username?: string; password?: string }> {
  if (request.username && request.password) {
    return { username: request.username, password: request.password };
  }
  if (request.password) {
    return { password: request.password };
  }
  if (request.credentialProvider) {
    const name = normalizeProviderName(request.credentialProvider);
    const provider = createProvider(name);
    const cred = await provider.resolve({ username: request.username });
    return { username: cred.username, password: cred.password };
  }
  return {};
}

/**
 * Initialize ProtonDriveClient (SDK), authenticating if necessary.
 * Password is always required — it flows via stdin from pass-cli,
 * or is resolved via git-credential when credentialProvider is set.
 */
async function getInitializedClient(request: BridgeRequest): Promise<ProtonDriveClient> {
  const resolved = await resolveRequestCredentials(request);
  const password = resolved.password;

  if (!password) {
    throw Object.assign(
      new Error('No session found and credentials not provided'),
      { code: ErrorCode.AUTH_FAILED }
    );
  }

  return createSDKClient(password, resolved.username);
}

/**
 * Ensure the LFS base directory exists
 */
async function ensureBaseDir(client: ProtonDriveClient, storageBase: string): Promise<string> {
  const normalizedBase = storageBase.replace(/^\/+|\/+$/g, '');
  await ensureFolderPath(client, `/${normalizedBase}`);
  return `/${normalizedBase}`;
}

// ─── CAPTCHA helper ─────────────────────────────────────────────────

export function formatCaptchaError(error: CaptchaError): BridgeResponse {
  return {
    ok: false,
    error: 'CAPTCHA verification required — run: proton-drive login',
    code: 407,
    details: JSON.stringify({
      captchaUrl: error.captchaUrl,
      captchaToken: error.captchaToken,
      verificationMethods: error.verificationMethods,
      action: 'run: proton-drive login',
    }),
  };
}

// ─── Command handlers ──────────────────────────────────────────────

async function handleAuthCommand(request: BridgeRequest): Promise<void> {
  try {
    const resolved = await resolveRequestCredentials(request);
    if (!resolved.username || !resolved.password) {
      writeError('username and password are required', 400);
      return;
    }

    // Session reuse: skip SRP if a valid session exists for this user
    try {
      if (await SessionManager.isSessionForUser(resolved.username)) {
        writeSuccess({ authenticated: true, sessionReused: true });
        return;
      }
    } catch {
      // Session file corrupted or unreadable — fall through to full login
    }

    const authService = new AuthService();

    await authService.login(resolved.username, resolved.password, undefined);
    writeSuccess({ authenticated: true });
  } catch (error: any) {
    // CAPTCHA required (use centralized detection)
    if (isCaptchaError(error)) {
      if (error instanceof CaptchaError) {
        writeResponse(formatCaptchaError(error));
      } else {
        writeError('CAPTCHA verification required — run: proton-drive login', 407);
      }
      return;
    }

    // Rate-limit (use centralized detection)
    if (isRateLimitError(error)) {
      const retryAfter = (error as any).retryAfter;
      const message = retryAfter
        ? `Rate limited by Proton API — wait ${retryAfter}s and retry`
        : 'Rate limited by Proton API — wait and retry';
      writeError(message, 429);
      return;
    }

    writeError(
      error.message || 'Authentication failed',
      errorToStatusCode(error)
    );
  }
}

// Singleton change token cache instance
const changeTokenCache = new ChangeTokenCache();

async function handleUploadCommand(request: BridgeRequest): Promise<void> {
  const { oid, path: filePath, storageBase = 'LFS' } = request;

  if (!oid || !filePath) {
    writeError('oid and path are required for upload', 400);
    return;
  }

  try {
    validateOid(oid);
    validateLocalPath(filePath);
    await fs.access(filePath);

    // Check if upload is needed based on change token
    const shouldUpload = await changeTokenCache.shouldUpload(oid, filePath);
    if (!shouldUpload) {
      logger.info(`Upload skipped for ${oid} (unchanged since last upload)`);
      // Get file stats for response (file hasn't changed, so use cached size)
      const stat = await fs.stat(filePath);
      writeSuccess({
        oid,
        fileId: 'cached', // Placeholder - actual fileId not needed for skipped uploads
        revisionId: '',
        uploaded: false,
        cached: true,
      });
      return;
    }

    const client = await getInitializedClient(request);
    await ensureBaseDir(client, storageBase);

    // Ensure prefix folder exists (first 2 chars of OID)
    const prefix = oid.substring(0, 2).toLowerCase();
    await ensureOidFolder(client, `/${storageBase}`, prefix);

    // Ensure second-level folder exists (chars 2-4 of OID)
    const second = oid.substring(2, 4).toLowerCase();
    await ensureOidFolder(client, `/${storageBase}/${prefix}`, second);

    // Upload file using OID-based path
    const targetPath = oidToPath(storageBase, oid);
    const fileName = path.basename(targetPath);
    const parentPath = path.dirname(targetPath);

    // Resolve parent folder to UID, then upload via SDK
    const parentUid = await ensureFolderPath(client, parentPath);
    const stat = await fs.stat(filePath);

    const fileStream = (await import('fs')).createReadStream(filePath);
    const webStream = Readable.toWeb(fileStream) as ReadableStream;

    const uploader = await client.getFileUploader(parentUid, fileName, {
      mediaType: 'application/octet-stream',
      expectedSize: stat.size,
    });
    const ctrl = await uploader.uploadFromStream(webStream, []);
    const { nodeUid } = await ctrl.completion();

    // Record successful upload in change token cache
    await changeTokenCache.recordUpload(oid, filePath);
    await changeTokenCache.save();

    writeSuccess({
      oid,
      fileId: nodeUid,
      revisionId: '', // SDK doesn't expose revision ID in the same way
      uploaded: true,
      cached: false,
    });
  } catch (error: any) {
    handleBridgeError(error, 'Upload failed');
  }
}

async function handleDownloadCommand(request: BridgeRequest): Promise<void> {
  const { oid, outputPath, storageBase = 'LFS' } = request;

  if (!oid || !outputPath) {
    writeError('oid and outputPath are required for download', 400);
    return;
  }

  try {
    validateOid(oid);
    validateLocalPath(outputPath);

    const client = await getInitializedClient(request);

    const nodeUid = await findFileByOid(client, storageBase, oid);
    if (!nodeUid) {
      writeError(`File not found for OID: ${oid}`, 404);
      return;
    }

    // Download via SDK
    const downloader = await client.getFileDownloader(nodeUid);
    const fileStream = (await import('fs')).createWriteStream(outputPath);
    const webStream = Writable.toWeb(fileStream) as WritableStream;

    const ctrl = downloader.downloadToStream(webStream);
    await ctrl.completion();

    const stat = await fs.stat(outputPath);

    writeSuccess({
      oid,
      outputPath,
      size: stat.size,
      downloaded: true,
    });
  } catch (error: any) {
    handleBridgeError(error, 'Download failed');
  }
}

async function handleListCommand(request: BridgeRequest): Promise<void> {
  const { folder, storageBase = 'LFS' } = request;

  try {
    const client = await getInitializedClient(request);
    const targetFolder = folder || `/${storageBase}`;

    const items = await listFolder(client, targetFolder);

    const files = items.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size,
      modifiedTime: item.modifiedTime,
    }));

    writeSuccess({ files });
  } catch (error: any) {
    writeError(
      error.message || 'List failed',
      errorToStatusCode(error)
    );
  }
}

async function handleExistsCommand(request: BridgeRequest): Promise<void> {
  const { oid, storageBase = 'LFS' } = request;

  if (!oid) {
    writeError('oid is required for exists', 400);
    return;
  }

  try {
    validateOid(oid);

    const client = await getInitializedClient(request);
    const nodeUid = await findFileByOid(client, storageBase, oid);

    writeSuccess({ oid, exists: !!nodeUid });
  } catch (error: any) {
    writeError(
      error.message || 'Exists check failed',
      errorToStatusCode(error)
    );
  }
}

async function handleDeleteCommand(request: BridgeRequest): Promise<void> {
  const { oid, storageBase = 'LFS' } = request;

  if (!oid) {
    writeError('oid is required for delete', 400);
    return;
  }

  try {
    validateOid(oid);

    const client = await getInitializedClient(request);
    const deleted = await deleteByOid(client, storageBase, oid);

    if (!deleted) {
      writeError(`File not found for OID: ${oid}`, 404);
      return;
    }

    writeSuccess({ oid, deleted: true });
  } catch (error: any) {
    writeError(
      error.message || 'Delete failed',
      errorToStatusCode(error)
    );
  }
}

async function handleRefreshCommand(request: BridgeRequest): Promise<void> {
  try {
    const authService = new AuthService();
    const session = await authService.refreshSession();
    writeSuccess({ refreshed: true, uid: session.uid });
  } catch (error: any) {
    writeError(
      error.message || 'Session refresh failed',
      errorToStatusCode(error)
    );
  }
}

async function handleInitCommand(request: BridgeRequest): Promise<void> {
  const { storageBase = 'LFS' } = request;

  try {
    const client = await getInitializedClient(request);
    const basePath = await ensureBaseDir(client, storageBase);

    writeSuccess({ storageBase, path: basePath, initialized: true });
  } catch (error: any) {
    writeError(
      error.message || 'Init failed',
      errorToStatusCode(error)
    );
  }
}

async function handleBatchExistsCommand(request: BridgeRequest): Promise<void> {
  const { oids, storageBase = 'LFS' } = request;

  if (!oids || !Array.isArray(oids) || oids.length === 0) {
    writeError('oids array is required for batch-exists', 400);
    return;
  }

  try {
    for (const oid of oids) {
      validateOid(oid);
    }

    const client = await getInitializedClient(request);
    const results: Record<string, boolean> = {};

    for (const oid of oids) {
      const nodeUid = await findFileByOid(client, storageBase, oid);
      results[oid] = !!nodeUid;
    }

    writeSuccess({ results });
  } catch (error: any) {
    writeError(
      error.message || 'Batch exists failed',
      errorToStatusCode(error)
    );
  }
}

async function handleBatchDeleteCommand(request: BridgeRequest): Promise<void> {
  const { oids, storageBase = 'LFS' } = request;

  if (!oids || !Array.isArray(oids) || oids.length === 0) {
    writeError('oids array is required for batch-delete', 400);
    return;
  }

  try {
    for (const oid of oids) {
      validateOid(oid);
    }

    const client = await getInitializedClient(request);
    const results: Record<string, boolean> = {};

    for (const oid of oids) {
      results[oid] = await deleteByOid(client, storageBase, oid);
    }

    writeSuccess({ results });
  } catch (error: any) {
    writeError(
      error.message || 'Batch delete failed',
      errorToStatusCode(error)
    );
  }
}

// ─── Command registration ──────────────────────────────────────────

/**
 * Create the bridge command for the CLI.
 *
 * Implements the JSON-based bridge protocol for Git LFS integration with the Go adapter.
 * Reads JSON requests from stdin, performs Proton Drive operations via SDK, and writes
 * JSON responses to stdout. Designed for subprocess communication with the Git LFS adapter.
 *
 * # Bridge Protocol
 *
 * **Request Format** (stdin):
 * ```json
 * {
 *   "command": "upload|download|exists|...",
 *   "oid": "abc123...",
 *   "path": "/tmp/file.bin",
 *   "credentialProvider": "git-credential|pass-cli",
 *   "storageBase": "LFS"
 * }
 * ```
 *
 * **Response Format** (stdout):
 * ```json
 * {
 *   "ok": true,
 *   "payload": { "oid": "abc123...", "uploaded": true }
 * }
 * ```
 *
 * **Error Response** (stdout):
 * ```json
 * {
 *   "ok": false,
 *   "error": "Upload failed",
 *   "code": 500,
 *   "details": "..."
 * }
 * ```
 *
 * # Supported Commands
 *
 * - **auth**: Authenticate with SRP, create session
 * - **upload**: Upload file to Drive (OID-based path, change token caching)
 * - **download**: Download file from Drive by OID
 * - **list**: List files in folder
 * - **exists**: Check if file exists by OID
 * - **delete**: Delete file by OID (moves to trash)
 * - **refresh**: Refresh access token using refresh token
 * - **init**: Initialize storage base directory
 * - **batch-exists**: Check multiple OIDs existence
 * - **batch-delete**: Delete multiple files by OID
 *
 * # Security Features
 *
 * - No output to stdout except JSON response (prevents Go adapter parsing errors)
 * - Credentials resolved via provider (never logged)
 * - Session reuse (avoids repeated SRP auth)
 * - CAPTCHA detection and guidance
 * - Rate-limit detection and retry guidance
 * - Change token caching (80% fewer uploads)
 *
 * # Error Handling
 *
 * - HTTP 400: Invalid request parameters
 * - HTTP 404: File not found
 * - HTTP 407: CAPTCHA required
 * - HTTP 429: Rate-limited by Proton API
 * - HTTP 500: Server error or operation failed
 *
 * # Exit Codes
 *
 * - 0: Command executed successfully (check response.ok)
 * - 1: Fatal error (JSON parsing, stdin timeout, unknown command)
 *
 * @returns Commander Command instance configured for bridge protocol
 * @throws {Error} Stdin timeout after 30 seconds
 * @throws {Error} JSON parsing error
 * @throws {Error} Unknown bridge command
 *
 * @example
 * ```bash
 * # Upload file via bridge protocol
 * echo '{"oid":"abc123...","path":"/tmp/file.bin","credentialProvider":"git-credential"}' \
 *   | proton-drive bridge upload
 *
 * # Download file via bridge protocol
 * echo '{"oid":"abc123...","outputPath":"/tmp/out.bin"}' \
 *   | proton-drive bridge download
 *
 * # Check if file exists
 * echo '{"oid":"abc123..."}' \
 *   | proton-drive bridge exists
 *
 * # Authenticate (session reuse supported)
 * echo '{"username":"user@proton.me","password":"..."}' \
 *   | proton-drive bridge auth
 *
 * # Batch exists check
 * echo '{"oids":["abc123...","def456..."]}' \
 *   | proton-drive bridge batch-exists
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage (Go adapter integration)
 * import { spawn } from 'child_process';
 *
 * const bridge = spawn('proton-drive', ['bridge', 'upload']);
 *
 * bridge.stdin.write(JSON.stringify({
 *   oid: 'abc123...',
 *   path: '/tmp/file.bin',
 *   credentialProvider: 'git-credential',
 * }));
 * bridge.stdin.end();
 *
 * bridge.stdout.on('data', (data) => {
 *   const response = JSON.parse(data.toString());
 *   if (response.ok) {
 *     console.log('Upload successful:', response.payload);
 *   } else {
 *     console.error('Upload failed:', response.error);
 *   }
 * });
 * ```
 *
 * @example
 * ```go
 * // Go adapter usage
 * cmd := exec.Command("proton-drive", "bridge", "upload")
 * cmd.Stdin = bytes.NewBufferString(`{"oid":"abc123...","path":"/tmp/file.bin"}`)
 * output, err := cmd.Output()
 * var response BridgeResponse
 * json.Unmarshal(output, &response)
 * ```
 *
 * @category CLI Commands
 * @see {@link handleUploadCommand} for upload implementation
 * @see {@link handleDownloadCommand} for download implementation
 * @see {@link handleAuthCommand} for authentication implementation
 * @see {@link ChangeTokenCache} for upload optimization
 * @since 0.1.0
 */
export function createBridgeCommand(): Command {
  const cmd = new Command('bridge');

  cmd
    .description(
      'Bridge mode for Git LFS integration — reads JSON from stdin, writes JSON to stdout'
    )
    .argument('<command>', 'Bridge command: auth, upload, download, list, exists, delete, refresh, init, batch-exists, batch-delete')
    .action(async (command: string) => {
      // Suppress all non-JSON output
      logger.setLevel(LogLevel.ERROR);

      try {
        const request = await readStdinJson();

        switch (command.toLowerCase()) {
          case 'auth':
            await handleAuthCommand(request);
            break;
          case 'upload':
            await handleUploadCommand(request);
            break;
          case 'download':
            await handleDownloadCommand(request);
            break;
          case 'list':
            await handleListCommand(request);
            break;
          case 'exists':
            await handleExistsCommand(request);
            break;
          case 'delete':
            await handleDeleteCommand(request);
            break;
          case 'refresh':
            await handleRefreshCommand(request);
            break;
          case 'init':
            await handleInitCommand(request);
            break;
          case 'batch-exists':
            await handleBatchExistsCommand(request);
            break;
          case 'batch-delete':
            await handleBatchDeleteCommand(request);
            break;
          default:
            writeError(`Unknown bridge command: ${command}`, 400);
        }
      } catch (error: any) {
        writeError(
          error.message || 'Bridge command failed',
          errorToStatusCode(error)
        );
        process.exit(1);
      }
    });

  return cmd;
}
