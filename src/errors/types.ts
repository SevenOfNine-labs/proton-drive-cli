/**
 * Error codes for different error scenarios
 */
export enum ErrorCode {
  // Authentication errors
  AUTH_FAILED = 'AUTH_FAILED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED',

  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',

  // API errors
  API_ERROR = 'API_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  NOT_FOUND = 'NOT_FOUND',

  // File system errors
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  DISK_FULL = 'DISK_FULL',

  // Upload/Download errors
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
  ENCRYPTION_FAILED = 'ENCRYPTION_FAILED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  INVALID_FILE = 'INVALID_FILE',

  // Path errors
  PATH_NOT_FOUND = 'PATH_NOT_FOUND',
  INVALID_PATH = 'INVALID_PATH',
  NOT_A_FOLDER = 'NOT_A_FOLDER',

  // CAPTCHA
  CAPTCHA_REQUIRED = 'CAPTCHA_REQUIRED',

  // Generic
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  OPERATION_CANCELLED = 'OPERATION_CANCELLED',
}

/**
 * Custom application error class with error codes and recovery hints
 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public details?: Record<string, any>,
    public isRecoverable: boolean = false
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to user-friendly message
   */
  toUserMessage(): string {
    switch (this.code) {
      case ErrorCode.AUTH_FAILED:
        return 'Authentication failed. Please check your credentials and try again.';

      case ErrorCode.SESSION_EXPIRED:
        return 'Your session has expired. Please login again with: proton-drive login';

      case ErrorCode.INVALID_CREDENTIALS:
        return 'Invalid email or password. Please check your credentials.';

      case ErrorCode.NETWORK_ERROR:
        return 'Network connection failed. Please check your internet connection and try again.';

      case ErrorCode.TIMEOUT:
        return 'Request timed out. The server took too long to respond.';

      case ErrorCode.CONNECTION_REFUSED:
        return 'Connection refused. The server may be down or unreachable.';

      case ErrorCode.FILE_NOT_FOUND:
        return `File not found: ${this.details?.path || 'unknown'}`;

      case ErrorCode.FILE_TOO_LARGE:
        return `File is too large. Maximum size: ${this.details?.maxSize || '100GB'}`;

      case ErrorCode.PERMISSION_DENIED:
        return `Permission denied: ${this.details?.path || 'unknown'}`;

      case ErrorCode.DISK_FULL:
        return 'No space left on device. Please free up some space and try again.';

      case ErrorCode.PATH_NOT_FOUND:
        return `Path not found: ${this.details?.path || 'unknown'}`;

      case ErrorCode.INVALID_PATH:
        return `Invalid path: ${this.details?.path || 'unknown'}`;

      case ErrorCode.NOT_A_FOLDER:
        return `Not a folder: ${this.details?.path || 'unknown'}`;

      case ErrorCode.RATE_LIMITED:
        return this.message || 'Too many requests. Please try again later.';

      case ErrorCode.QUOTA_EXCEEDED:
        return 'Storage quota exceeded. Please free up space in your Proton Drive.';

      case ErrorCode.NOT_FOUND:
        return 'Resource not found. The file or folder may have been deleted.';

      case ErrorCode.UPLOAD_FAILED:
        return 'Upload failed. Please check your connection and try again.';

      case ErrorCode.DOWNLOAD_FAILED:
        return 'Download failed. Please check your connection and try again.';

      case ErrorCode.ENCRYPTION_FAILED:
        return 'Encryption failed. This may indicate a corrupted file or crypto issue.';

      case ErrorCode.DECRYPTION_FAILED:
        return 'Decryption failed. This may indicate corrupted data or wrong keys.';

      case ErrorCode.CAPTCHA_REQUIRED:
        return 'CAPTCHA verification required. Please complete the verification and try again.';

      case ErrorCode.OPERATION_CANCELLED:
        return 'Operation cancelled by user.';

      case ErrorCode.VALIDATION_ERROR:
        return this.message || 'Validation error. Please check your input.';

      default:
        return this.message || 'An unknown error occurred.';
    }
  }

  /**
   * Get recovery suggestion for the error
   */
  getRecoverySuggestion(): string | null {
    switch (this.code) {
      case ErrorCode.AUTH_FAILED:
      case ErrorCode.SESSION_EXPIRED:
        return 'Run: proton-drive login';

      case ErrorCode.NETWORK_ERROR:
      case ErrorCode.TIMEOUT:
      case ErrorCode.CONNECTION_REFUSED:
        return 'Check your internet connection and try again';

      case ErrorCode.RATE_LIMITED:
        return 'Wait a few moments before trying again';

      case ErrorCode.QUOTA_EXCEEDED:
        return 'Free up space in your Proton Drive or upgrade your plan';

      case ErrorCode.FILE_NOT_FOUND:
        return 'Check that the file path is correct';

      case ErrorCode.PATH_NOT_FOUND:
        return 'Check that the folder path exists in your Drive';

      case ErrorCode.PERMISSION_DENIED:
        return 'Check file permissions or try running with appropriate privileges';

      case ErrorCode.DISK_FULL:
        return 'Free up disk space on your local machine';

      case ErrorCode.CAPTCHA_REQUIRED:
        return 'Run: proton-drive login (interactive CAPTCHA flow will guide you)';

      default:
        return null;
    }
  }
}

/**
 * CAPTCHA verification error with structured metadata
 */
export class CaptchaError extends AppError {
  public readonly captchaUrl: string;
  public readonly captchaToken: string;
  public readonly verificationMethods: string[];

  constructor(options: {
    captchaUrl: string;
    captchaToken: string;
    verificationMethods?: string[];
  }) {
    super('CAPTCHA verification required', ErrorCode.CAPTCHA_REQUIRED, {
      captchaUrl: options.captchaUrl,
      captchaToken: options.captchaToken,
    }, true);
    this.name = 'CaptchaError';
    this.captchaUrl = options.captchaUrl;
    this.captchaToken = options.captchaToken;
    this.verificationMethods = options.verificationMethods || [];
  }
}

/**
 * Rate-limit error with retry timing information
 */
export class RateLimitError extends AppError {
  public readonly retryAfter?: number; // seconds until retry allowed
  public readonly protonCode?: number; // Proton-specific error code

  constructor(
    message: string,
    options?: {
      retryAfter?: number;
      protonCode?: number;
    }
  ) {
    super(message, ErrorCode.RATE_LIMITED, {
      retryAfter: options?.retryAfter,
      protonCode: options?.protonCode,
    }, false); // Not recoverable by retry
    this.name = 'RateLimitError';
    this.retryAfter = options?.retryAfter;
    this.protonCode = options?.protonCode;
  }
}

/**
 * Detect if an error is a rate-limit error from Proton API
 * @param error - Error object to check
 * @returns True if rate-limit error (code 2028, 85131, or HTTP 429)
 */
export function isRateLimitError(error: any): error is RateLimitError {
  if (error instanceof RateLimitError) return true;

  // Check Proton-specific error codes
  const protonCode = error?.response?.data?.Code;
  if (protonCode === 2028 || protonCode === 85131) return true;

  // Check HTTP 429 status
  if (error?.response?.status === 429) return true;

  return false;
}

/**
 * Detect if an error is a CAPTCHA error from Proton API
 * @param error - Error object to check
 * @returns True if CAPTCHA error (codes 9001, 12087, or Details.HumanVerificationToken present)
 */
export function isCaptchaError(error: any): error is CaptchaError {
  if (error instanceof CaptchaError) return true;

  // Check Proton CAPTCHA codes
  const protonCode = error?.response?.data?.Code;
  if (protonCode === 9001 || protonCode === 12087) return true;

  // Check for HumanVerificationToken in Details
  const details = error?.response?.data?.Details;
  if (details?.HumanVerificationToken) return true;

  return false;
}

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  NETWORK = 'network',
  AUTH = 'auth',
  RATE_LIMIT = 'rate_limit',
  CAPTCHA = 'captcha',
  NOT_FOUND = 'not_found',
  PERMISSION = 'permission',
  SERVER = 'server',
  CLIENT = 'client',
  UNKNOWN = 'unknown',
}

/**
 * Categorized error with metadata for error handling decisions
 */
export interface CategorizedError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  userMessage: string;
  protonCode?: number;
  httpStatus?: number;
  recoverySuggestion?: string;
}

/**
 * Categorize an error into a standardized format for consistent handling
 * @param error - Error object to categorize
 * @returns CategorizedError with category, retryability, and user-friendly message
 */
export function categorizeError(error: any): CategorizedError {
  // Extract HTTP status and Proton code before type narrowing
  const status = error?.response?.status;
  const protonCode = error?.response?.data?.Code;

  // Rate-limit errors (never retry)
  if (isRateLimitError(error)) {
    return {
      category: ErrorCategory.RATE_LIMIT,
      message: error.message || 'Rate limit exceeded',
      retryable: false,
      userMessage: 'Rate limit exceeded. Please wait before retrying.',
      protonCode: (error as RateLimitError).protonCode || protonCode,
      httpStatus: status,
      recoverySuggestion: 'Wait a few moments before trying again',
    };
  }

  // CAPTCHA errors (requires user intervention)
  if (isCaptchaError(error)) {
    return {
      category: ErrorCategory.CAPTCHA,
      message: error.message || 'CAPTCHA verification required',
      retryable: false,
      userMessage: 'CAPTCHA verification required. Run: proton-drive login',
      protonCode,
      httpStatus: status,
      recoverySuggestion: 'Run: proton-drive login (interactive CAPTCHA flow will guide you)',
    };
  }

  // Permission errors (403 with specific permission keyword) - check before auth
  if (status === 403 && error.message?.toLowerCase().includes('permission')) {
    return {
      category: ErrorCategory.PERMISSION,
      message: error.message,
      retryable: false,
      userMessage: 'Permission denied. You may not have access to this resource.',
      httpStatus: 403,
      protonCode,
      recoverySuggestion: 'Check that you have the necessary permissions for this operation',
    };
  }

  // Authentication errors (401, 403)
  if (status === 401 || status === 403) {
    return {
      category: ErrorCategory.AUTH,
      message: error.message || 'Authentication failed',
      retryable: false,
      userMessage: 'Authentication failed. Please login again.',
      httpStatus: status,
      protonCode,
      recoverySuggestion: 'Run: proton-drive login',
    };
  }

  // Not found errors (404)
  if (status === 404) {
    return {
      category: ErrorCategory.NOT_FOUND,
      message: error.message || 'Resource not found',
      retryable: false,
      userMessage: 'File or folder not found.',
      httpStatus: 404,
      protonCode,
    };
  }

  // Server errors (5xx) - retryable
  if (status >= 500 && status < 600) {
    return {
      category: ErrorCategory.SERVER,
      message: error.message || 'Server error',
      retryable: true,
      userMessage: 'Proton server error. Operation will be retried.',
      httpStatus: status,
      protonCode,
    };
  }

  // Client errors (4xx except handled above) - not retryable
  if (status >= 400 && status < 500) {
    return {
      category: ErrorCategory.CLIENT,
      message: error.message || 'Client error',
      retryable: false,
      userMessage: 'Invalid request. Please check your input and try again.',
      httpStatus: status,
      protonCode,
    };
  }

  // Network errors (connection issues) - retryable
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return {
      category: ErrorCategory.NETWORK,
      message: error.message || 'Network connection failed',
      retryable: true,
      userMessage: 'Network connection failed. Operation will be retried.',
      recoverySuggestion: 'Check your internet connection and try again',
    };
  }

  // Default: unknown error
  return {
    category: ErrorCategory.UNKNOWN,
    message: error.message || 'An unexpected error occurred',
    retryable: false,
    userMessage: 'An unexpected error occurred.',
  };
}
