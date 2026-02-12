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
