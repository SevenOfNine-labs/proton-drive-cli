import * as fs from 'fs-extra';
import { RateLimitError } from '../errors/types';
import { logger } from '../utils/logger';
import { writePrivateJsonFile } from './private-json-file';
import { RATE_LIMIT_COOLDOWN_FILE } from './state-dir';

/**
 * Persisted rate-limit cooldown shared by all bridge subprocesses: once Proton
 * answers HTTP 429 (or codes 2028/85131), every process on the machine stops
 * calling the API until `cooldownUntil`, instead of each discovering the
 * limit on its own. The file is written without the session lock: the
 * refresh request itself can be rate limited while that lock is held.
 */
export interface RateLimitCooldown {
  cooldownUntil: number;
  retryAfter: number;
  protonCode?: number;
  message?: string;
  recordedAt: string;
}

/** Applied when the response carries no usable Retry-After (RFC 9110 §10.2.3). */
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;

function normalizeRetryAfterSeconds(retryAfter?: number): number {
  if (retryAfter && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter);
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
}

export async function recordRateLimitCooldown(options: {
  retryAfter?: number;
  protonCode?: number;
  message?: string;
} = {}): Promise<RateLimitCooldown> {
  const retryAfter = normalizeRetryAfterSeconds(options.retryAfter);
  const now = Date.now();
  const cooldown: RateLimitCooldown = {
    cooldownUntil: now + retryAfter * 1000,
    retryAfter,
    ...(options.protonCode !== undefined && { protonCode: options.protonCode }),
    ...(options.message && { message: options.message }),
    recordedAt: new Date(now).toISOString(),
  };

  // Concurrent subprocesses may record cooldowns at the same time; the file
  // keeps whichever ends later so a short Retry-After never shortens a
  // longer one already in force.
  const current = await readCooldownFile();
  if (current && current.cooldownUntil >= cooldown.cooldownUntil) {
    return current;
  }
  await writePrivateJsonFile(RATE_LIMIT_COOLDOWN_FILE, cooldown);
  return cooldown;
}

async function readCooldownFile(): Promise<RateLimitCooldown | null> {
  try {
    const raw = await fs.readJson(RATE_LIMIT_COOLDOWN_FILE) as Partial<RateLimitCooldown>;
    if (!raw || typeof raw.cooldownUntil !== 'number') return null;
    return {
      cooldownUntil: raw.cooldownUntil,
      retryAfter: typeof raw.retryAfter === 'number' ? raw.retryAfter : DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS,
      ...(raw.protonCode !== undefined && { protonCode: raw.protonCode }),
      ...(raw.message && { message: raw.message }),
      recordedAt: raw.recordedAt || new Date(raw.cooldownUntil).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function getActiveRateLimitCooldown(now: number = Date.now()): Promise<RateLimitCooldown | null> {
  try {
    if (!await fs.pathExists(RATE_LIMIT_COOLDOWN_FILE)) return null;

    const cooldown = await fs.readJson(RATE_LIMIT_COOLDOWN_FILE) as Partial<RateLimitCooldown>;
    // An expired file is ignored rather than deleted: another process may
    // be replacing it with a fresh cooldown at this moment.
    if (!cooldown || typeof cooldown.cooldownUntil !== 'number' || cooldown.cooldownUntil <= now) {
      return null;
    }

    return {
      cooldownUntil: cooldown.cooldownUntil,
      retryAfter: Math.max(1, Math.ceil((cooldown.cooldownUntil - now) / 1000)),
      ...(cooldown.protonCode !== undefined && { protonCode: cooldown.protonCode }),
      ...(cooldown.message && { message: cooldown.message }),
      recordedAt: cooldown.recordedAt || new Date(cooldown.cooldownUntil).toISOString(),
    };
  } catch (error) {
    logger.warn('Failed to load rate-limit cooldown:', error);
    return null;
  }
}

export async function assertNotRateLimited(): Promise<void> {
  const cooldown = await getActiveRateLimitCooldown();
  if (!cooldown) return;

  throw new RateLimitError(
    cooldown.message || 'Rate limited by Proton API',
    {
      retryAfter: cooldown.retryAfter,
      protonCode: cooldown.protonCode,
    },
  );
}

export async function clearRateLimitCooldown(): Promise<void> {
  await fs.remove(RATE_LIMIT_COOLDOWN_FILE).catch(() => {});
}
