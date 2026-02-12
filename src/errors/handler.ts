import chalk from 'chalk';
import { AppError, ErrorCode } from './types';
import { HttpClientError, isHttpClientError } from '../api/http-client';

/**
 * Map HTTP client errors to app errors
 */
export function mapHttpError(error: HttpClientError): AppError {
  // No response - network error
  if (!error.response) {
    if (error.code === 'ECONNREFUSED') {
      return new AppError(
        'Connection refused',
        ErrorCode.CONNECTION_REFUSED,
        { originalError: error.message },
        true
      );
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return new AppError(
        'Request timed out',
        ErrorCode.TIMEOUT,
        { originalError: error.message },
        true
      );
    }
    return new AppError(
      'Network error',
      ErrorCode.NETWORK_ERROR,
      { originalError: error.message },
      true
    );
  }

  const statusCode = error.response.status;
  const responseData = error.response.data as Record<string, unknown>;

  // Map HTTP status codes
  if (statusCode === 401) {
    return new AppError(
      'Authentication failed',
      ErrorCode.AUTH_FAILED,
      { statusCode, apiError: responseData },
      false
    );
  }

  if (statusCode === 403) {
    return new AppError(
      'Permission denied',
      ErrorCode.PERMISSION_DENIED,
      { statusCode, apiError: responseData },
      false
    );
  }

  if (statusCode === 404) {
    return new AppError(
      'Resource not found',
      ErrorCode.NOT_FOUND,
      { statusCode, apiError: responseData },
      false
    );
  }

  if (statusCode === 429) {
    const retryAfter = error.response.headers['retry-after'] || 60;
    return new AppError(
      'Rate limited',
      ErrorCode.RATE_LIMITED,
      { statusCode, retryAfter },
      true
    );
  }

  if (statusCode === 507) {
    return new AppError(
      'Storage quota exceeded',
      ErrorCode.QUOTA_EXCEEDED,
      { statusCode },
      false
    );
  }

  if (statusCode >= 500) {
    return new AppError(
      'Server error',
      ErrorCode.API_ERROR,
      { statusCode, apiError: responseData },
      true // Server errors are recoverable (might be temporary)
    );
  }

  return new AppError(
    error.message || 'API request failed',
    ErrorCode.API_ERROR,
    { statusCode, apiError: responseData },
    false
  );
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
 * Convert any error to AppError
 */
export function toAppError(error: unknown): AppError {
  // Already an AppError
  if (error instanceof AppError) {
    return error;
  }

  // HTTP client error
  if (isHttpClientError(error)) {
    return mapHttpError(error);
  }

  // Node.js system error
  if ((error as NodeJS.ErrnoException).code) {
    return mapSystemError(error as NodeJS.ErrnoException);
  }

  // Generic Error
  if (error instanceof Error) {
    return new AppError(
      error.message,
      ErrorCode.UNKNOWN_ERROR,
      { originalError: error.name },
      false
    );
  }

  // Unknown error type
  return new AppError(
    String(error),
    ErrorCode.UNKNOWN_ERROR,
    {},
    false
  );
}

/**
 * Handle and format error for CLI display
 */
export function handleError(error: unknown, debug: boolean = false): void {
  const appError = toAppError(error);

  // Display main error message
  console.error(chalk.red.bold('\n✗ Error:'), appError.toUserMessage());

  // Show recovery suggestion
  const suggestion = appError.getRecoverySuggestion();
  if (suggestion) {
    console.error(chalk.yellow('\n💡 Suggestion:'), suggestion);
  }

  // Show recovery hint for temporary errors
  if (appError.isRecoverable && !suggestion) {
    console.error(chalk.yellow('\n💡 This error may be temporary. Please try again.'));
  }

  // Show details in debug mode
  if (debug) {
    console.error(chalk.dim('\n📋 Debug Information:'));
    console.error(chalk.dim('  Error Code:'), appError.code);
    console.error(chalk.dim('  Technical Message:'), appError.message);
    console.error(chalk.dim('  Recoverable:'), appError.isRecoverable);

    if (appError.details && Object.keys(appError.details).length > 0) {
      console.error(chalk.dim('  Details:'));
      console.error(chalk.dim(JSON.stringify(appError.details, null, 4)));
    }

    if (appError.stack) {
      console.error(chalk.dim('\n📚 Stack Trace:'));
      console.error(chalk.dim(appError.stack));
    }
  } else {
    console.error(chalk.dim('\n💻 Run with --debug for detailed error information'));
  }
}
