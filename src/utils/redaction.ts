export const REDACTED_VALUE = '[redacted]';

const EXACT_SENSITIVE_KEYS = new Set([
  'accesstoken',
  'authorization',
  'armoredkey',
  'captchatoken',
  'clientephemeral',
  'clientproof',
  'datapassword',
  'fido2',
  'humanverificationtoken',
  'loginpassword',
  'mailboxpassword',
  'privatekey',
  'refreshtoken',
  'serverproof',
  'srpsession',
  'twofactorcode',
  'uid',
  'xpmhumanverificationtoken',
  'xpmuid',
]);

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b((?:access|refresh|captcha|human[-_]?verification|session|password|secret|token)[A-Za-z0-9_-]*=)[^&\s]+/gi;

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return redacted;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactValue(child, seen);
  }
  seen.delete(value);
  return redacted;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  if (normalized.includes('password') || normalized.includes('secret')) {
    return true;
  }
  if (normalized.includes('privatekey') || normalized.includes('armoredkey')) {
    return true;
  }
  return normalized.endsWith('token') && normalized !== 'tokentype';
}
