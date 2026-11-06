import * as fs from 'fs-extra';
import writeFileAtomic from 'write-file-atomic';
import { STATE_DIR } from './state-dir';

/**
 * Write a JSON document to the state directory atomically (temp file plus
 * rename, via write-file-atomic) with owner-only permissions, so a concurrent
 * reader never sees a partial file and other users never see the content.
 */
export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(STATE_DIR, { mode: 0o700 });
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
