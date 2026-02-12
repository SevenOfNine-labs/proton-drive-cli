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
import { AppError, ErrorCode, CaptchaError } from '../errors/types';
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
import { gitCredentialFill } from '../utils/git-credential';

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
 * Resolve credentials from request, falling back to git-credential
 * when credentialProvider === 'git-credential'.
 */
async function resolveRequestCredentials(request: BridgeRequest): Promise<{ username?: string; password?: string }> {
  if (request.username && request.password) {
    return { username: request.username, password: request.password };
  }
  if (request.password) {
    return { password: request.password };
  }
  if (request.credentialProvider === 'git-credential') {
    const cred = await gitCredentialFill();
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
    // CAPTCHA required (Proton API code 9001)
    if (error instanceof CaptchaError) {
      writeResponse(formatCaptchaError(error));
      return;
    }

    // Invalid/expired CAPTCHA token (Proton API code 12087)
    if (error?.response?.data?.Code === 12087) {
      writeError('CAPTCHA token invalid or expired — run: proton-drive login', 407);
      return;
    }

    // Abuse rate-limit (Proton API code 2028 / HTTP 422)
    if (error instanceof AppError && error.code === ErrorCode.RATE_LIMITED) {
      writeError('rate limited by Proton API — wait and retry', 429);
      return;
    }
    if (error?.response?.data?.Code === 2028) {
      writeError('rate limited by Proton API — wait and retry', 429);
      return;
    }

    writeError(
      error.message || 'Authentication failed',
      errorToStatusCode(error)
    );
  }
}

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

    writeSuccess({
      oid,
      fileId: nodeUid,
      revisionId: '', // SDK doesn't expose revision ID in the same way
      uploaded: true,
    });
  } catch (error: any) {
    writeError(
      error.message || 'Upload failed',
      errorToStatusCode(error)
    );
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
    writeError(
      error.message || 'Download failed',
      errorToStatusCode(error)
    );
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
