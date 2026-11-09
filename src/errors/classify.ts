/**
 * Maps every failure to an AppError whose code sets the bridge status (bridge/protocol), the
 * `details.errorCode` (schemas/bridge/v1/error-code-map.json) and the retry policy (utils/retry).
 * Imports only errors/types and the SDK error classes, so bridge/validators stays light.
 */

import {
  AbortError,
  ConnectionError,
  DecryptionError,
  IntegrityError,
  NodeWithSameNameExistsValidationError,
  ProtonDriveError,
  RateLimitedError,
  ServerError,
  ValidationError,
} from '@protontech/drive-sdk';
import { AppError, ErrorCode, RateLimitError, isCaptchaError, isRateLimitError } from './types';

/** Proton API code for an access token or app that lacks the required scope. */
export const PROTON_CODE_INSUFFICIENT_SCOPE = 9101;

/** Shape shared by HttpClientError and any error carrying an HTTP response. */
export interface HttpLikeError {
  message?: string;
  code?: unknown;
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: unknown;
  };
}

export type HttpResponseError = HttpLikeError & { response: { status: number } };

export function hasHttpResponse(error: unknown): error is HttpResponseError {
  const response = (error as HttpLikeError | null | undefined)?.response;
  return typeof response === 'object' && response !== null && typeof response.status === 'number';
}

function protonCodeOf(data: unknown): number | undefined {
  const code = (data as { Code?: unknown } | null | undefined)?.Code;
  return typeof code === 'number' ? code : undefined;
}

function retryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * Map an HTTP status plus optional Proton API code to an AppError. Proton code
 * 9101 (insufficient scope) can arrive on any status and takes precedence.
 */
function mapStatus(
  status: number | undefined,
  protonCode: number | undefined,
  message: string | undefined,
  details: Record<string, unknown>,
): AppError {
  const withCodes = {
    ...details,
    ...(status !== undefined && { statusCode: status }),
    ...(protonCode !== undefined && { protonCode }),
  };

  if (protonCode === PROTON_CODE_INSUFFICIENT_SCOPE) {
    return new AppError(
      message || 'Access token does not have sufficient Proton scope',
      ErrorCode.INSUFFICIENT_SCOPE,
      withCodes,
      false,
    );
  }

  switch (status) {
    case 401:
      return new AppError('Authentication failed', ErrorCode.AUTH_FAILED, withCodes, false);
    case 403:
      return new AppError('Permission denied', ErrorCode.PERMISSION_DENIED, withCodes, false);
    case 404:
      return new AppError('Resource not found', ErrorCode.NOT_FOUND, withCodes, false);
    case 408:
      return new AppError('Request timed out: the server took too long to respond', ErrorCode.TIMEOUT, withCodes, true);
    case 413:
      return new AppError('File is too large', ErrorCode.FILE_TOO_LARGE, withCodes, false);
    case 422:
      return new AppError(message || 'Request rejected by Proton API', ErrorCode.VALIDATION_ERROR, withCodes, false);
    case 429: {
      const retryAfter = retryAfterSeconds(details.retryAfter) ?? 60;
      const error = new RateLimitError('Rate limited', { retryAfter, protonCode });
      error.details = { ...withCodes, retryAfter };
      return error;
    }
    case 507:
      return new AppError('Storage quota exceeded', ErrorCode.QUOTA_EXCEEDED, withCodes, false);
    default:
      break;
  }

  if (status !== undefined && status >= 500) {
    return new AppError('Server error', ErrorCode.API_ERROR, withCodes, true);
  }

  return new AppError(message || 'API request failed', ErrorCode.API_ERROR, withCodes, false);
}

/**
 * Map an HTTP client error (HttpClientError or any error carrying
 * `response.status`) to an AppError.
 */
export function mapHttpError(error: HttpLikeError): AppError {
  if (!hasHttpResponse(error)) {
    if (error.code === 'ECONNREFUSED') {
      return new AppError('Connection refused', ErrorCode.CONNECTION_REFUSED, { originalError: error.message }, true);
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return new AppError('Request timed out: the server took too long to respond', ErrorCode.TIMEOUT, { originalError: error.message }, true);
    }
    if (error.code === 'EBADJSON') {
      // The server answered but its body was not valid JSON: a protocol
      // error on the server side, not a transport failure worth retrying.
      return new AppError('Invalid response from Proton API', ErrorCode.API_ERROR, { originalError: error.message }, false);
    }
    return new AppError('Network error', ErrorCode.NETWORK_ERROR, { originalError: error.message }, true);
  }

  const apiError = error.response.data;
  return mapStatus(error.response.status, protonCodeOf(apiError), error.message, {
    apiError,
    retryAfter: retryAfterSeconds(error.response.headers?.['retry-after']),
  });
}

/**
 * Map a Proton Drive SDK error to an AppError.
 *
 * ServerError carries the HTTP status (`statusCode`) and Proton API code
 * (`code`); both feed the same status mapping as HTTP client errors so that a
 * 401/403 is never reported as a retryable server error.
 */
export function mapSdkError(error: ProtonDriveError): AppError {
  const details: Record<string, unknown> = { sdkError: error.name };

  if (error instanceof AbortError) {
    return new AppError(error.message || 'Operation cancelled', ErrorCode.OPERATION_CANCELLED, details, false);
  }
  if (error instanceof ConnectionError) {
    return new AppError(error.message || 'Network error', ErrorCode.NETWORK_ERROR, details, true);
  }
  if (error instanceof RateLimitedError) {
    const rateLimited = new RateLimitError(error.message || 'Rate limited', { protonCode: error.code });
    rateLimited.details = { ...details, statusCode: error.statusCode, protonCode: error.code };
    return rateLimited;
  }
  if (error instanceof ServerError) {
    return mapStatus(error.statusCode, error.code, error.message, details);
  }
  if (error instanceof NodeWithSameNameExistsValidationError) {
    return new AppError(error.message, ErrorCode.VALIDATION_ERROR, {
      ...details,
      protonCode: error.code,
      existingNodeUid: error.existingNodeUid,
    }, false);
  }
  if (error instanceof ValidationError) {
    if (error.code === PROTON_CODE_INSUFFICIENT_SCOPE) {
      return mapStatus(undefined, error.code, error.message, details);
    }
    return new AppError(error.message, ErrorCode.VALIDATION_ERROR, { ...details, protonCode: error.code }, false);
  }
  if (error instanceof DecryptionError || error instanceof IntegrityError) {
    return new AppError(error.message, ErrorCode.DECRYPTION_FAILED, details, false);
  }

  return new AppError(error.message || 'Proton Drive SDK error', ErrorCode.UNKNOWN_ERROR, details, false);
}

/**
 * Map Node.js system errors to app errors
 */
export function mapSystemError(error: NodeJS.ErrnoException): AppError {
  switch (error.code) {
    case 'ENOENT':
      return new AppError(
        'File or directory not found',
        ErrorCode.FILE_NOT_FOUND,
        { path: error.path, syscall: error.syscall },
        false
      );

    case 'EACCES':
    case 'EPERM':
      return new AppError(
        'Permission denied',
        ErrorCode.PERMISSION_DENIED,
        { path: error.path, syscall: error.syscall },
        false
      );

    case 'ENOSPC':
      return new AppError(
        'No space left on device',
        ErrorCode.DISK_FULL,
        { path: error.path },
        false
      );

    // proper-lockfile rejects with ELOCKED while another process holds the lock.
    case 'ELOCKED':
      return new AppError('The session lock is held by another process', ErrorCode.TIMEOUT, {}, true);

    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return new AppError(
        'Operation timed out',
        ErrorCode.TIMEOUT,
        {},
        true
      );

    case 'ECONNREFUSED':
      return new AppError(
        'Connection refused',
        ErrorCode.CONNECTION_REFUSED,
        {},
        true
      );

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new AppError(
        'Network error - DNS lookup failed',
        ErrorCode.NETWORK_ERROR,
        {},
        true
      );

    case 'ECONNRESET':
      return new AppError(
        'Connection reset by peer',
        ErrorCode.NETWORK_ERROR,
        {},
        true
      );

    default:
      return new AppError(
        error.message || 'System error',
        ErrorCode.UNKNOWN_ERROR,
        { originalCode: error.code, syscall: error.syscall },
        false
      );
  }
}

/**
 * Error-shaped value. Errors raised by Node.js internals can come from a
 * different realm (e.g. under a vm context), where `instanceof Error` is
 * false, so the shape is checked instead.
 */
function isErrorLike(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && typeof (error as Error).message === 'string';
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return isErrorLike(error) && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/**
 * Convert any thrown value to an AppError.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ProtonDriveError) {
    return mapSdkError(error);
  }

  if (isRateLimitError(error)) {
    const response = hasHttpResponse(error) ? error.response : undefined;
    const rateLimited = new RateLimitError(errorMessage(error) || 'Rate limited', {
      retryAfter: retryAfterSeconds(response?.headers?.['retry-after']) ?? 60,
      protonCode: protonCodeOf(response?.data),
    });
    rateLimited.details = { ...rateLimited.details, statusCode: response?.status };
    return rateLimited;
  }

  if (isCaptchaError(error)) {
    const response = hasHttpResponse(error) ? error.response : undefined;
    const data = response?.data as { Details?: { HumanVerificationMethods?: unknown } } | undefined;
    return new AppError('CAPTCHA verification required', ErrorCode.CAPTCHA_REQUIRED, {
      statusCode: response?.status,
      protonCode: protonCodeOf(response?.data),
      verificationMethods: data?.Details?.HumanVerificationMethods,
    }, false);
  }

  if (hasHttpResponse(error) || (isErrorLike(error) && error.name === 'HttpClientError')) {
    return mapHttpError(error as HttpLikeError);
  }

  if (isErrnoError(error)) {
    return mapSystemError(error);
  }

  if (isErrorLike(error)) {
    return new AppError(
      error.message,
      ErrorCode.UNKNOWN_ERROR,
      { originalError: error.name },
      false
    );
  }

  return new AppError(
    String(error),
    ErrorCode.UNKNOWN_ERROR,
    {},
    false
  );
}
