/**
 * API server clock for OpenPGP dates, as Proton's official clients use it (sdk
 * `cli/src/api/serverTimeHook.ts`), learned from each response's `x-pm-date` or `date` header.
 */

import { updateServerTime as updateProtonCryptoServerTime } from '@protontech/crypto/serverTime';

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
  updateProtonCryptoServerTime(serverDate);
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

/** Test helper: forget the learned offset; the crypto clock advances to the device time. */
export function resetServerTime(): void {
  serverTimeOffsetMs = 0;
  synced = false;
  updateProtonCryptoServerTime(new Date());
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
