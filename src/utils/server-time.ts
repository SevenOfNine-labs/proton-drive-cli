/**
 * Server-time synchronisation for OpenPGP operations.
 *
 * Proton's official clients (and the SDK CLI since js/v0.23.0, see
 * `cli/src/api/serverTimeHook.ts` upstream) date keys and signatures with the
 * API server's clock instead of the device clock: a device clock that runs
 * ahead produces keys and signatures "from the future" that the API rejects
 * as invalid, and a clock that runs behind rejects material other clients
 * just created. The offset is learned from the `x-pm-date` or `date` header
 * of every API response and applied by the OpenPGP proxy.
 */

let serverTimeOffsetMs = 0;
let synced = false;

/** Record the server clock observed in an API response. */
export function updateServerTime(serverDate: Date): void {
  const timestamp = serverDate.getTime();
  if (!Number.isFinite(timestamp)) {
    return;
  }
  serverTimeOffsetMs = timestamp - Date.now();
  synced = true;
}

/** Record the server clock from response headers (`x-pm-date` wins over `date`). */
export function updateServerTimeFromHeaders(headers: Headers | Record<string, string> | undefined): void {
  const serverDate = parseDate(getHeader(headers, 'x-pm-date')) ?? parseDate(getHeader(headers, 'date'));
  if (serverDate) {
    updateServerTime(serverDate);
  }
}

/** Current time as seen by the Proton API (device time until the first response). */
export function serverTime(): Date {
  return new Date(Date.now() + serverTimeOffsetMs);
}

export function isServerTimeSynced(): boolean {
  return synced;
}

/** Test helper: forget the learned offset. */
export function resetServerTime(): void {
  serverTimeOffsetMs = 0;
  synced = false;
}

function getHeader(headers: Headers | Record<string, string> | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

function parseDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
