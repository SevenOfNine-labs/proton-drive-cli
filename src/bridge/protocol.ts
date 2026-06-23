import { ErrorCode } from '../errors/types';

export const BRIDGE_COMMANDS = [
  'auth-state',
  'upload',
  'download',
  'list',
  'exists',
  'delete',
  'refresh',
  'init',
  'batch-exists',
  'batch-delete',
] as const;

export type BridgeCommand = typeof BRIDGE_COMMANDS[number];

export function isBridgeCommand(command: string): command is BridgeCommand {
  return (BRIDGE_COMMANDS as readonly string[]).includes(command);
}

export const BRIDGE_AUTH_STATES = [
  'ready',
  'needs_login',
  'needs_data_password',
  'needs_key_password',
  'session_expired',
  'session_invalid',
  'configuration_error',
] as const;

export type BridgeAuthState = typeof BRIDGE_AUTH_STATES[number];

export const BRIDGE_REQUEST_FIELDS = [
  'dataPassword',
  'dataCredentialProvider',
  'dataCredentialHost',
  'appVersion',
  'oid',
  'path',
  'outputPath',
  'folder',
  'storageBase',
  'oids',
] as const;

export type BridgeRequestField = typeof BRIDGE_REQUEST_FIELDS[number];

export interface BridgeCommandRequestFields {
  required: readonly BridgeRequestField[];
  allowed: readonly BridgeRequestField[];
}

export const BRIDGE_COMMON_REQUEST_FIELDS = [
  'dataPassword',
  'dataCredentialProvider',
  'dataCredentialHost',
  'appVersion',
  'storageBase',
] as const satisfies readonly BridgeRequestField[];

export const BRIDGE_COMMAND_REQUEST_FIELDS = {
  'auth-state': {
    required: [],
    allowed: BRIDGE_COMMON_REQUEST_FIELDS,
  },
  upload: {
    required: ['oid', 'path'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oid', 'path'],
  },
  download: {
    required: ['oid', 'outputPath'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oid', 'outputPath'],
  },
  list: {
    required: [],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'folder'],
  },
  exists: {
    required: ['oid'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oid'],
  },
  delete: {
    required: ['oid'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oid'],
  },
  refresh: {
    required: [],
    allowed: ['appVersion'],
  },
  init: {
    required: [],
    allowed: BRIDGE_COMMON_REQUEST_FIELDS,
  },
  'batch-exists': {
    required: ['oids'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oids'],
  },
  'batch-delete': {
    required: ['oids'],
    allowed: [...BRIDGE_COMMON_REQUEST_FIELDS, 'oids'],
  },
} as const satisfies Record<BridgeCommand, BridgeCommandRequestFields>;

export const BRIDGE_RESPONSE_FIELDS = [
  'ok',
  'payload',
  'error',
  'code',
  'details',
] as const;

export const BRIDGE_ERROR_DETAIL_FIELDS = [
  'errorCode',
  'twoFactorType',
  'totpAllowed',
  'fido2Available',
  'captchaUrl',
  'captchaToken',
  'verificationMethods',
  'action',
  'retryAfter',
  'protonCode',
] as const;

export const ERROR_CODE_STATUS = {
  [ErrorCode.AUTH_FAILED]: 401,
  [ErrorCode.SESSION_EXPIRED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.TWO_FACTOR_REQUIRED]: 401,
  [ErrorCode.DATA_PASSWORD_REQUIRED]: 401,
  [ErrorCode.KEY_PASSWORD_REQUIRED]: 401,
  [ErrorCode.NETWORK_ERROR]: 502,
  [ErrorCode.TIMEOUT]: 504,
  [ErrorCode.CONNECTION_REFUSED]: 502,
  [ErrorCode.API_ERROR]: 502,
  [ErrorCode.INSUFFICIENT_SCOPE]: 403,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.QUOTA_EXCEEDED]: 507,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.FILE_NOT_FOUND]: 404,
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.DISK_FULL]: 507,
  [ErrorCode.UPLOAD_FAILED]: 502,
  [ErrorCode.DOWNLOAD_FAILED]: 502,
  [ErrorCode.ENCRYPTION_FAILED]: 500,
  [ErrorCode.DECRYPTION_FAILED]: 500,
  [ErrorCode.INVALID_FILE]: 400,
  [ErrorCode.PATH_NOT_FOUND]: 404,
  [ErrorCode.INVALID_PATH]: 400,
  [ErrorCode.NOT_A_FOLDER]: 400,
  [ErrorCode.CAPTCHA_REQUIRED]: 407,
  [ErrorCode.UNKNOWN_ERROR]: 500,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.OPERATION_CANCELLED]: 499,
} satisfies Record<ErrorCode, number>;

export function statusCodeForErrorCode(code: unknown): number | undefined {
  if (typeof code !== 'string') return undefined;
  return ERROR_CODE_STATUS[code as ErrorCode];
}
