import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AuthService } from '../auth';
import { BrowserForkAuthService, type BrowserForkAuthServiceOptions } from '../auth/browser-fork';
import { createKeyPasswordStore } from '../auth/key-password-store';
import { SessionManager } from '../auth/session';
import { DEFAULT_KEY_PASSWORD_PROVIDER } from '../credentials';
import { AppError, ErrorCode, RateLimitError } from '../errors/types';
import { toAppError } from '../errors/classify';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';
import { authTrace } from '../utils/auth-trace';
import { redactSensitive, uidFingerprint } from '../utils/redaction';

export interface BrowserForkKeyPasswordOptions {
  keyPasswordProvider?: string;
  keyPasswordHost?: string;
}

/**
 * Resolve the key-password store options: command option, then
 * PROTON_KEY_PASSWORD_PROVIDER / PROTON_KEY_PASSWORD_HOST, then the default
 * provider (pass-cli). No other environment variable is consulted.
 */
export function resolveBrowserForkKeyPasswordOptions(
  options: BrowserForkKeyPasswordOptions = {}
): BrowserForkAuthServiceOptions {
  const keyPasswordProvider =
    options.keyPasswordProvider?.trim() ||
    process.env.PROTON_KEY_PASSWORD_PROVIDER?.trim() ||
    DEFAULT_KEY_PASSWORD_PROVIDER;
  const keyPasswordHost =
    options.keyPasswordHost?.trim() ||
    process.env.PROTON_KEY_PASSWORD_HOST?.trim();

  return {
    keyPasswordProvider,
    ...(keyPasswordHost ? { keyPasswordHost } : {}),
  };
}

export async function loginWithBrowserFork(
  authService: BrowserForkAuthService = new BrowserForkAuthService()
): Promise<void> {
  authTrace('cli.login.browser-fork.start');
  let spinner: ReturnType<typeof ora> | undefined;
  if (isVerbose()) {
    spinner = ora('Starting browser sign-in...').start();
  }

  try {
    await authService.login({
      onSignInUrl: (signInUrl: string) => {
        if (spinner) {
          spinner.stop();
          spinner = undefined;
        }

        const opened = openBrowserUrl(signInUrl);
        if (!isQuiet()) {
          console.log(chalk.cyan('Complete Proton sign-in in your browser.'));
          console.log(chalk.dim(opened
            ? 'A browser window was opened for Proton account sign-in.'
            : 'Could not open a browser automatically.'
          ));
          console.log(chalk.dim('If needed, open this URL manually:'));
          console.log(signInUrl);
        }

        if (isVerbose()) {
          spinner = ora('Waiting for browser sign-in...').start();
        }
      },
    });

    if (spinner) {
      spinner.succeed(chalk.green('Browser login successful!'));
    }
    if (isVerbose()) {
      console.log(chalk.dim('Session saved (tokens only). Browser key password stored in the configured credential provider.'));
    } else if (!isQuiet()) {
      outputResult('OK');
    }
    authTrace('cli.login.browser-fork.success');
  } catch (error: unknown) {
    if (spinner) {
      spinner.stop();
    }
    authTrace('cli.login.browser-fork.failure', traceErrorFields(error));
    throw error;
  }
}

/**
 * Create the login command for the CLI.
 *
 * Authenticates with Proton Drive through Proton's browser session-fork flow.
 * The command never accepts or resolves the Proton account password.
 *
 * # Security Features
 *
 * - Account password is entered only in Proton's browser sign-in page
 * - Session tokens are persisted in the CLI session file
 * - Browser-derived key password is stored in the configured credential provider
 *
 * # Exit Codes
 *
 * - 0: Login successful or already authenticated
 * - 1: Authentication failed, timed out, or browser approval was cancelled
 *
 * @returns Commander Command instance configured for login
 *
 * @example
 * ```bash
 * # Browser login
 * proton-drive-cli login
 *
 * # Store browser-derived key password in Proton Pass
 * proton-drive-cli login --key-password-provider pass-cli
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createLoginCommand } from './cli/login';
 *
 * const program = new Command();
 * program.addCommand(createLoginCommand());
 * program.parse(process.argv);
 * ```
 *
 * @category CLI Commands
 * @see {@link createLogoutCommand} for logging out
 * @see {@link createStatusCommand} for checking authentication status
 */
export function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Authenticate with Proton Drive through browser sign-in')
    .option('--key-password-provider <type>', `Credential provider for browser-fork key password: pass-cli (default) or git-credential`)
    .option('--key-password-host <host>', 'Credential host/key for browser-fork key password')
    .action(async (options) => {
      try {
        authTrace('cli.login.start', {
          keyPasswordProvider: options.keyPasswordProvider,
          keyPasswordHost: options.keyPasswordHost,
        });
        await loginWithBrowserFork(new BrowserForkAuthService(
          resolveBrowserForkKeyPasswordOptions(options)
        ));
      } catch (error) {
        authTrace('cli.login.failure', traceErrorFields(error));
        handleError(error, process.env.DEBUG === 'true');
        process.exitCode = 1;
      }
    });

  return command;
}

function traceErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      errorName: error.name,
      errorCode: error.code,
      errorMessage: error.message,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }
  return { errorMessage: String(error) };
}

/**
 * Create the logout command for the CLI.
 *
 * Logs out from Proton Drive: removes the stored key password, revokes the
 * session on the server (DELETE /auth/v4) and deletes the session file
 * (~/.proton-drive-cli/session.json) and the crypto cache. The command is
 * idempotent and safe to run when not authenticated.
 *
 * # Behavior
 *
 * - Saved session, whether or not its access token has expired: the key
 *   password, the server session and the local files are removed; a failed
 *   server revocation is reported as a warning
 * - session.json that `login` did not write: the file and the crypto cache
 *   are deleted
 * - No session.json: displays "Not currently logged in" and exits 0
 *
 * # Exit Codes
 *
 * - 0: Logout successful or already logged out
 * - 1: Error deleting session file (permissions, I/O error, etc.)
 *
 * @returns Commander Command instance configured for logout
 *
 * @example
 * ```bash
 * # Logout from Proton Drive
 * proton-drive-cli logout
 * # Output: ✓ Logged out successfully
 *
 * # Logout when not authenticated
 * proton-drive-cli logout
 * # Output: Not currently logged in
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createLogoutCommand } from './cli/login';
 *
 * const program = new Command();
 * program.addCommand(createLogoutCommand());
 * program.parse(['logout'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createLoginCommand} for logging in
 * @see {@link createStatusCommand} for checking authentication status
 * @see {@link AuthService.logout} for underlying logout logic
 */
export function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Logout and clear current session')
    .action(async () => {
      try {
        const stored = await SessionManager.readStoredSession();
        if (stored.kind === 'none') {
          console.log(chalk.yellow('Not currently logged in'));
          return;
        }

        const { revoked } = await new AuthService().logout();
        if (stored.kind === 'valid' && !revoked) {
          console.error(chalk.yellow('Warning: the session could not be revoked on the server; it ends when its tokens expire.'));
        }
        console.log(chalk.green('✓ Logged out successfully'));
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Create the status command for the CLI.
 *
 * Displays the current authentication status and session information. If
 * authenticated, shows the session UID, its scopes and whether the stored key
 * password is available. If not authenticated, prompts the user to login.
 *
 * # Session Information Displayed
 *
 * - **Session UID**: Proton session identifier
 * - **Scopes**: API scopes granted to the session (e.g., drive, calendar)
 * - **Key Password**: whether the session's credential provider holds it
 *
 * # Exit Codes
 *
 * - 0: Status retrieved successfully (authenticated or not)
 * - 1: Error reading session file (corrupted, I/O error, etc.)
 *
 * @returns Commander Command instance configured for status check
 *
 * @example
 * ```bash
 * # Check authentication status (authenticated)
 * proton-drive-cli status
 * # Output:
 * # ✓ Authenticated
 * #
 * # Session Information:
 * #   Session UID: abc123xyz
 * #   Scopes: drive, calendar
 * #   Key Password: Stored (pass-cli)
 *
 * # Check authentication status (not authenticated)
 * proton-drive-cli status
 * # Output:
 * # ✗ Not authenticated
 * #
 * # Run: proton-drive-cli login
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createStatusCommand } from './cli/login';
 *
 * const program = new Command();
 * program.addCommand(createStatusCommand());
 * await program.parseAsync(['status'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createLoginCommand} for logging in
 * @see {@link createLogoutCommand} for logging out
 * @see {@link AuthService.isAuthenticated} for authentication check logic
 */
export function createStatusCommand(): Command {
  const command = new Command('status');

  command
    .description('Show authentication status')
    .action(async () => {
      try {
        const authService = new AuthService();
        const isAuthenticated = await authService.isAuthenticated();

        if (isAuthenticated) {
          const session = await authService.getSession();
          console.log(chalk.green('✓ Authenticated\n'));
          console.log(chalk.cyan('Session Information:'));
          console.log(`  ${chalk.dim('Session UID:')} ${session.uid}`);
          console.log(`  ${chalk.dim('Scopes:')} ${(session.scopes ?? []).join(', ')}`);
          const keyPasswordStore = createKeyPasswordStore({
            provider: session.keyPasswordProvider,
            host: session.keyPasswordHost,
          });
          const keyPasswordAvailable = await keyPasswordStore.verify(session.uid);
          console.log(`  ${chalk.dim('Key Password:')} ${keyPasswordAvailable ? 'Stored' : 'Missing'} (${keyPasswordStore.provider})`);
        } else {
          console.log(chalk.yellow('✗ Not authenticated'));
          console.log(chalk.dim('\nRun:'), chalk.bold('proton-drive-cli login'));
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exitCode = 1;
      }
    });

  return command;
}

/**
 * Create the session refresh command.
 *
 * Refreshes the access token using the refresh token stored in the session file.
 * This command is designed for headless automation (e.g., system tray heartbeat)
 * and operates silently to avoid interfering with user workflows.
 *
 * # Behavior
 *
 * - **If session exists**: Calls POST /auth/v4/refresh to get new access token
 * - **If no session exists**: Exits silently with code 0 (nothing to refresh)
 * - **On success**: Updates session file and exits silently with code 0
 * - **On failure**: Exits with code 1 (optionally logs error if DEBUG=true)
 *
 * # Scheduling
 *
 * - Uses POST /auth/v4/refresh (not a login attempt), so it cannot trigger
 *   CAPTCHA verification.
 * - Refresh requests are rate-limited by Proton like any other endpoint, and a
 *   refresh token is single-use: the caller schedules one refresh shortly
 *   before `tokenExpiresAt` (the tray refreshes 10 minutes before expiry) and
 *   stops when the token is rejected (`--json` reports `protonCode` 10013).
 * - Concurrent refreshes are serialized through the session file lock.
 *
 * # Exit Codes
 *
 * - 0: Token refreshed successfully, or no session exists
 * - 1: Token refresh failed (expired refresh token, network error, etc.)
 *
 * @returns Commander Command instance configured for session refresh
 *
 * @example
 * ```bash
 * # Refresh session token (silent on success)
 * proton-drive-cli session refresh
 * echo $?
 * # Output: 0
 *
 * # Machine-readable result for the tray scheduler
 * proton-drive-cli session refresh --json
 * # Output: {"ok":true,"refreshed":true,"state":"refreshed","uidFingerprint":"…","tokenExpiresAt":…}
 *
 * # Refresh with debug output
 * DEBUG=true proton-drive-cli session refresh
 * # Output: (error details if refresh fails)
 * ```
 *
 * @category CLI Commands
 * @see {@link createLoginCommand} for initial authentication
 * @see {@link AuthService.refreshSession} for underlying refresh logic
 */
export function createSessionRefreshCommand(): Command {
  const command = new Command('session');

  command
    .command('refresh')
    .description('Refresh the access token (used by tray heartbeat)')
    .option('--json', 'Emit a structured machine-readable refresh result')
    .action(async (options: { json?: boolean } = {}) => {
      try {
        const session = await SessionManager.loadSession();
        if (!session) {
          if (options.json) {
            console.log(JSON.stringify({
              ok: true,
              refreshed: false,
              state: 'no_session',
              action: 'none',
            }));
          }
          return;
        }

        const updated = await SessionManager.refreshSession(session);
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            refreshed: true,
            state: 'refreshed',
            uidFingerprint: uidFingerprint(updated.uid),
            tokenExpiresAt: updated.tokenExpiresAt,
          }));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify(refreshErrorEnvelope(error)));
        } else if (process.env.DEBUG === 'true') {
          handleError(error, true);
        }
        // stdout writes can complete asynchronously; process.exit would drop them.
        process.exitCode = 1;
      }
    });

  return command;
}

function refreshErrorEnvelope(error: unknown): Record<string, unknown> {
  const appError = toAppError(error);
  const details = redactSensitive(appError.details || {}) as Record<string, unknown>;
  const statusCode = typeof details.statusCode === 'number' ? details.statusCode : undefined;
  const apiError = typeof details.apiError === 'object' && details.apiError !== null
    ? details.apiError as Record<string, unknown>
    : undefined;
  const protonCode = apiError?.Code;
  const protonError = apiError?.Error;
  // Only a session that is gone or replaced (SESSION_EXPIRED) ends the refresh schedule.
  const sessionEnded = appError.code === ErrorCode.SESSION_EXPIRED;
  const retryAfter = appError instanceof RateLimitError ? appError.retryAfter : undefined;

  return {
    ok: false,
    state: 'refresh_failed',
    error: appError.toUserMessage(),
    errorCode: appError.code,
    recoverable: !sessionEnded,
    ...(statusCode !== undefined && { statusCode }),
    ...(protonCode !== undefined && { protonCode }),
    ...(typeof protonError === 'string' && protonError !== '' && { protonError }),
    ...(retryAfter !== undefined && { retryAfter }),
    action: sessionEnded
      ? 'stop: refresh token rejected or session invalid; run proton-drive-cli login'
      : 'retry_after_backoff',
    details,
  };
}
