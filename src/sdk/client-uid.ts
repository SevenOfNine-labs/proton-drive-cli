import { randomUUID } from 'crypto';
import * as fs from 'fs-extra';
import { lock } from 'proper-lockfile';
import { PROTON_APP_NAME } from '../constants';
import { writePrivateJsonFile } from '../auth/private-json-file';
import { CLIENT_UID_FILE, CLIENT_UID_LOCK_PATH, STATE_DIR } from '../auth/state-dir';
import { logger } from '../utils/logger';

/** Prefix of this CLI's client UIDs; the official CLI uses `sdk-js-cli-` (sdk cli/src/proton-drive.ts). */
export const CLIENT_UID_PREFIX = `${PROTON_APP_NAME}-`;

/** proper-lockfile: concurrent bridge subprocesses wait for the one creating the file. */
const CLIENT_UID_LOCK_OPTIONS = {
  lockfilePath: CLIENT_UID_LOCK_PATH,
  realpath: false,
  stale: 10_000,
  retries: { retries: 20, factor: 1.5, minTimeout: 50, maxTimeout: 1_000 },
};

async function readClientUid(): Promise<string | null> {
  try {
    const { clientUid } = (await fs.readJson(CLIENT_UID_FILE)) as { clientUid?: unknown };
    return typeof clientUid === 'string' && clientUid.startsWith(CLIENT_UID_PREFIX) ? clientUid : null;
  } catch {
    return null;
  }
}

/**
 * The client UID of this installation, created once in client-uid.json as
 * the official CLI does (sdk cli/src/clientUid.ts). ProtonDriveClient tags
 * upload drafts with it and deletes a draft of its own that blocks a new
 * upload of the same name, such as one left by an interrupted transfer
 * (sdk client/js/src/interface/config.ts `clientUid`). Undefined when the
 * file can be neither read nor created; the SDK then treats every draft as
 * another client's.
 */
export async function loadClientUid(): Promise<string | undefined> {
  const existing = await readClientUid();
  if (existing) {
    return existing;
  }
  try {
    await fs.ensureDir(STATE_DIR, { mode: 0o700 });
    const release = await lock(CLIENT_UID_FILE, {
      ...CLIENT_UID_LOCK_OPTIONS,
      onCompromised: (error: Error) => logger.warn(`Client UID lock compromised: ${error.message}`),
    });
    try {
      const current = await readClientUid();
      if (current) {
        return current;
      }
      const created = `${CLIENT_UID_PREFIX}${randomUUID()}`;
      await writePrivateJsonFile(CLIENT_UID_FILE, { clientUid: created });
      logger.debug('Created the client UID for upload drafts');
      return created;
    } finally {
      await release().catch(() => undefined);
    }
  } catch (error) {
    logger.warn(`No client UID for upload drafts: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
