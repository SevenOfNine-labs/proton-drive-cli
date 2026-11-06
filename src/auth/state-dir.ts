import * as path from 'path';
import { homedir } from 'os';

/**
 * Per-user state of the CLI (`~/.proton-drive-cli`, mode 0700): the session
 * tokens, their cross-process lock, the crypto-init cache and the rate-limit
 * cooldown. Every file in it is written with mode 0600.
 */
export const STATE_DIR = path.join(homedir(), '.proton-drive-cli');
export const SESSION_FILE = path.join(STATE_DIR, 'session.json');
/** proper-lockfile lock directory guarding refresh-token rotation on SESSION_FILE. */
export const SESSION_LOCK_PATH = path.join(STATE_DIR, 'session.lock');
export const CRYPTO_CACHE_FILE = path.join(STATE_DIR, 'crypto-cache.json');
export const RATE_LIMIT_COOLDOWN_FILE = path.join(STATE_DIR, 'rate-limit-cooldown.json');
