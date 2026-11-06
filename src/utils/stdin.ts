import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { AppError, ErrorCode } from '../errors/types';

/**
 * Check if stdin is being piped (not a TTY)
 */
export function isStdinPiped(): boolean {
  return !process.stdin.isTTY;
}

/**
 * A spool file holding piped stdin, owned by the caller until `cleanup()`.
 */
export interface StdinTempFile {
  /** Absolute path of the spooled data */
  path: string;
  /** Remove the spool file and its private directory */
  cleanup(): Promise<void>;
}

/**
 * Spool stdin to a temporary file and return it.
 *
 * The SDK needs the size upfront and may read the data more than once, so the
 * stream is written to disk first. The file lives in a private directory from
 * fs.mkdtemp (mode 0700) and is created exclusively (`wx`) with mode 0600, so
 * no other user can pre-create or read it.
 */
export async function readStdinToTempFile(): Promise<StdinTempFile> {
  if (!isStdinPiped()) {
    throw new AppError(
      'No input provided via stdin',
      ErrorCode.INVALID_FILE,
      {},
      false
    );
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proton-drive-upload-'));
  const tmpFile = path.join(tmpDir, 'stdin');
  const cleanup = async (): Promise<void> => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  };

  try {
    await pipeline(process.stdin, createWriteStream(tmpFile, { flags: 'wx', mode: 0o600 }));

    const stats = await fs.stat(tmpFile);
    if (stats.size === 0) {
      throw new AppError(
        'No data received from stdin',
        ErrorCode.INVALID_FILE,
        {},
        false
      );
    }

    return { path: tmpFile, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Extract filename from destination path
 * /Documents/myfile.txt -> myfile.txt
 * /Documents/ -> null
 */
export function extractFilenameFromPath(destinationPath: string): string | null {
  const parts = destinationPath.split('/').filter(p => p.length > 0);

  if (parts.length === 0) {
    return null;
  }

  const lastPart = parts[parts.length - 1];

  // Check if last part looks like a filename (has extension or no trailing slash)
  if (!destinationPath.endsWith('/') && lastPart.includes('.')) {
    return lastPart;
  }

  return null;
}

/**
 * Get parent path from destination
 * /Documents/myfile.txt -> /Documents
 * /Documents/ -> /Documents
 * /myfile.txt -> /
 */
export function getParentPath(destinationPath: string): string {
  const parts = destinationPath.split('/').filter(p => p.length > 0);

  // If destination looks like a filename (doesn't end with / and has extension)
  if (!destinationPath.endsWith('/') && parts.length > 0 && parts[parts.length - 1].includes('.')) {
    parts.pop(); // Remove filename
  }

  return '/' + parts.join('/');
}
