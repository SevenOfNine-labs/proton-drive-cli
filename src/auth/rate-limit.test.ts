import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { RateLimitError } from '../errors/types';
import {
  assertNotRateLimited,
  clearRateLimitCooldown,
  DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS,
  getActiveRateLimitCooldown,
  recordRateLimitCooldown,
} from './rate-limit';
import { RATE_LIMIT_COOLDOWN_FILE, STATE_DIR } from './state-dir';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  const realFs = jest.requireActual('fs');
  const realPath = jest.requireActual('path');
  const home = realFs.mkdtempSync(realPath.join(actual.tmpdir(), 'proton-drive-cli-rate-limit-'));
  return { ...actual, homedir: () => home };
});

describe('rate-limit cooldown', () => {
  const now = Date.UTC(2026, 5, 21, 12, 0, 0);
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await clearRateLimitCooldown();
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  afterAll(async () => {
    await fs.remove(os.homedir());
  });

  it('records a persisted cooldown with owner-only permissions', async () => {
    const cooldown = await recordRateLimitCooldown({
      retryAfter: 120,
      protonCode: 2028,
      message: 'Too many requests',
    });

    expect(cooldown.retryAfter).toBe(120);
    expect(cooldown.cooldownUntil).toBe(now + 120_000);
    expect(RATE_LIMIT_COOLDOWN_FILE.startsWith(STATE_DIR)).toBe(true);
    expect((await fs.stat(RATE_LIMIT_COOLDOWN_FILE)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(STATE_DIR)).mode & 0o777).toBe(0o700);
    expect(await fs.readJson(RATE_LIMIT_COOLDOWN_FILE)).toMatchObject({
      cooldownUntil: now + 120_000,
      retryAfter: 120,
      protonCode: 2028,
      message: 'Too many requests',
    });
    expect(path.dirname(RATE_LIMIT_COOLDOWN_FILE)).toBe(STATE_DIR);
  });

  it('applies the default cooldown when Retry-After is missing or invalid', async () => {
    expect((await recordRateLimitCooldown({})).retryAfter).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS);
    expect((await recordRateLimitCooldown({ retryAfter: Number.NaN })).retryAfter).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS);
  });

  it('returns the active cooldown with the remaining seconds and raises it as RateLimitError', async () => {
    await recordRateLimitCooldown({ retryAfter: 120, protonCode: 85131 });

    const cooldown = await getActiveRateLimitCooldown(now + 30_000);
    expect(cooldown?.retryAfter).toBe(90);
    expect(cooldown?.protonCode).toBe(85131);

    nowSpy.mockReturnValue(now + 30_000);
    await expect(assertNotRateLimited()).rejects.toBeInstanceOf(RateLimitError);
    await expect(assertNotRateLimited()).rejects.toMatchObject({ retryAfter: 90, protonCode: 85131 });
  });

  it('ignores expired cooldowns without deleting the file', async () => {
    await recordRateLimitCooldown({ retryAfter: 60 });

    expect(await getActiveRateLimitCooldown(now + 60_000)).toBeNull();
    // Another process may be replacing the file; reading never removes it.
    expect(await fs.pathExists(RATE_LIMIT_COOLDOWN_FILE)).toBe(true);
    nowSpy.mockReturnValue(now + 60_000);
    await expect(assertNotRateLimited()).resolves.toBeUndefined();
  });

  it('ignores an unreadable cooldown file', async () => {
    await fs.ensureDir(STATE_DIR);
    await fs.writeFile(RATE_LIMIT_COOLDOWN_FILE, '{"cooldownUntil":"soon"}');

    expect(await getActiveRateLimitCooldown(now)).toBeNull();
  });

  it('keeps the longer cooldown when a shorter one is recorded later', async () => {
    await recordRateLimitCooldown({ retryAfter: 3600 });
    const second = await recordRateLimitCooldown({ retryAfter: 60 });

    expect(second.cooldownUntil).toBe(now + 3_600_000);
    expect((await fs.readJson(RATE_LIMIT_COOLDOWN_FILE)).cooldownUntil).toBe(now + 3_600_000);
  });

  it('extends the cooldown when a longer one is recorded later', async () => {
    await recordRateLimitCooldown({ retryAfter: 60 });
    await recordRateLimitCooldown({ retryAfter: 600 });

    expect((await fs.readJson(RATE_LIMIT_COOLDOWN_FILE)).cooldownUntil).toBe(now + 600_000);
  });
});
