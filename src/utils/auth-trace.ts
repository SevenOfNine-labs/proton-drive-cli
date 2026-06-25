import { redactSensitive } from './redaction';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isAuthTraceEnabled(): boolean {
  const explicit = process.env.PROTON_AUTH_TRACE?.trim().toLowerCase();
  return (explicit ? TRUE_VALUES.has(explicit) : false) || process.env.DEBUG === 'true';
}

export function maskIdentifier(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const atIndex = trimmed.indexOf('@');
  if (atIndex > 0) {
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);
    return `${maskToken(local)}@${domain}`;
  }

  return maskToken(trimmed);
}

export function authTrace(event: string, fields: Record<string, unknown> = {}): void {
  if (!isAuthTraceEnabled()) return;

  const payload = redactSensitive({
    ts: new Date().toISOString(),
    traceId: process.env.PROTON_AUTH_TRACE_ID?.trim() || undefined,
    event,
    ...fields,
  });

  try {
    process.stderr.write(`[AUTH_TRACE] ${JSON.stringify(payload)}\n`);
  } catch {
    // Tracing must never affect auth behavior.
  }
}

function maskToken(value: string): string {
  if (value.length <= 2) {
    return '*'.repeat(value.length);
  }
  if (value.length <= 6) {
    return `${value[0]}***${value[value.length - 1]}`;
  }
  return `${value.slice(0, 2)}***${value[value.length - 1]}`;
}
