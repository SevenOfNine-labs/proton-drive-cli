import {
  isServerTimeSynced,
  resetServerTime,
  serverTime,
  updateServerTime,
  updateServerTimeFromHeaders,
} from './server-time';

describe('server-time', () => {
  afterEach(() => {
    resetServerTime();
  });

  test('returns device time before any sync', () => {
    expect(isServerTimeSynced()).toBe(false);
    expect(Math.abs(serverTime().getTime() - Date.now())).toBeLessThan(1000);
  });

  test('applies the observed server offset', () => {
    const oneHourBehind = new Date(Date.now() - 3_600_000);
    updateServerTime(oneHourBehind);

    expect(isServerTimeSynced()).toBe(true);
    expect(Math.abs(serverTime().getTime() - (Date.now() - 3_600_000))).toBeLessThan(1000);
  });

  test('ignores invalid dates', () => {
    updateServerTime(new Date('not a date'));
    expect(isServerTimeSynced()).toBe(false);
  });

  test('reads the date header from a Headers object', () => {
    const headerDate = new Date(Date.now() + 120_000);
    updateServerTimeFromHeaders(new Headers({ date: headerDate.toUTCString() }));

    expect(isServerTimeSynced()).toBe(true);
    // HTTP dates have one-second precision.
    expect(Math.abs(serverTime().getTime() - headerDate.getTime())).toBeLessThan(2000);
  });

  test('prefers x-pm-date over date and accepts plain header records', () => {
    const pmDate = new Date(Date.now() - 300_000);
    updateServerTimeFromHeaders({
      Date: new Date().toUTCString(),
      'X-PM-Date': pmDate.toUTCString(),
    });

    expect(Math.abs(serverTime().getTime() - pmDate.getTime())).toBeLessThan(2000);
  });

  test('ignores responses without a parseable date', () => {
    updateServerTimeFromHeaders(new Headers({ date: 'garbage' }));
    updateServerTimeFromHeaders(undefined);
    expect(isServerTimeSynced()).toBe(false);
  });
});

describe('server-time propagation to @protontech/crypto', () => {
  test('feeds the observed server date into the crypto endpoint clock, which only moves forward', async () => {
    await jest.isolateModulesAsync(async () => {
      const local = await import('./server-time');
      const crypto = await import('@protontech/crypto/serverTime');
      const serverDate = new Date(Date.now() - 3_600_000);

      local.updateServerTime(serverDate);
      expect(crypto.serverTime().getTime()).toBe(serverDate.getTime());

      // pmcrypto keeps the newest server date it has seen.
      local.updateServerTime(new Date(serverDate.getTime() - 1_000));
      expect(crypto.serverTime().getTime()).toBe(serverDate.getTime());

      local.resetServerTime();
      expect(Math.abs(crypto.serverTime().getTime() - Date.now())).toBeLessThan(1_000);
    });
  });
});
