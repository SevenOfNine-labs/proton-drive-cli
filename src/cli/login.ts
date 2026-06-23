import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AuthService } from '../auth';
import { BrowserForkAuthService, type BrowserForkAuthServiceOptions } from '../auth/browser-fork';
import { createKeyPasswordStore } from '../auth/key-password-store';
import { SessionManager } from '../auth/session';
import { AppError } from '../errors/types';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';
import { authTrace } from '../utils/auth-trace';

export interface BrowserForkKeyPasswordOptions {
  keyPasswordProvider?: string;
  keyPasswordHost?: string;
}

export function resolveBrowserForkKeyPasswordOptions(
  options: BrowserForkKeyPasswordOptions = {}
): BrowserForkAuthServiceOptions {
  const keyPasswordProvider =
    options.keyPasswordProvider?.trim() ||
    process.env.PROTON_KEY_PASSWORD_PROVIDER?.trim() ||
    process.env.PROTON_CREDENTIAL_PROVIDER?.trim();
  const keyPasswordHost =
    options.keyPasswordHost?.trim() ||
    process.env.PROTON_KEY_PASSWORD_HOST?.trim();

  return {
    ...(keyPasswordProvider ? { keyPasswordProvider } : {}),
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
 * proton-drive login
 *
 * # Store browser-derived key password in Proton Pass
 * proton-drive login --key-password-provider pass-cli
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
 * @since 0.1.0
 */
export function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Authenticate with Proton Drive through browser sign-in')
    .option('--key-password-provider <type>', 'Credential provider for browser-fork key password: git-credential or pass-cli')
    .option('--key-password-host <host>', 'Credential host/key for browser-fork key password')
    .action(async (options) => {
      try {
        authTrace('cli.login.start', {
          authMode: 'browser-fork',
          keyPasswordProvider: options.keyPasswordProvider,
          keyPasswordHost: options.keyPasswordHost,
        });
        await loginWithBrowserFork(new BrowserForkAuthService(
          resolveBrowserForkKeyPasswordOptions(options)
        ));
      } catch (error) {
        authTrace('cli.login.failure', traceErrorFields(error));
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
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
 * Logs out from Proton Drive by clearing the current session. This removes the
 * session file (~/.proton-drive-cli/session.json) containing access and refresh
 * tokens. The command is idempotent and safe to run when not authenticated.
 *
 * # Behavior
 *
 * - If authenticated: Clears session file and displays success message
 * - If not authenticated: Displays "Not currently logged in" warning and exits 0
 * - Session is cleared locally only (no API call to revoke tokens)
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
 * proton-drive logout
 * # Output: ✓ Logged out successfully
 *
 * # Logout when not authenticated
 * proton-drive logout
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
 * @since 0.1.0
 */
export function createLogoutCommand(): Command {
  const command = new Command('logout');

  command
    .description('Logout and clear current session')
    .action(async () => {
      try {
        const authService = new AuthService();
        const isAuthenticated = await authService.isAuthenticated();

        if (!isAuthenticated) {
          console.log(chalk.yellow('Not currently logged in'));
          return;
        }

        await authService.logout();
        console.log(chalk.green('✓ Logged out successfully'));
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return command;
}

/**
 * Create the status command for the CLI.
 *
 * Displays the current authentication status and session information. If authenticated,
 * shows detailed session metadata including user ID, session ID (truncated for security),
 * scopes, and password mode. If not authenticated, prompts user to login.
 *
 * # Session Information Displayed
 *
 * - **User ID**: Unique Proton user identifier (UID)
 * - **Session ID**: Session identifier (first 20 characters shown)
 * - **Scopes**: API scopes granted to the session (e.g., drive, calendar)
 * - **Password Mode**: Single password (mode 1) or two-password mode (mode 2)
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
 * proton-drive status
 * # Output:
 * # ✓ Authenticated
 * #
 * # Session Information:
 * #   User ID: abc123xyz
 * #   Session ID: session123456789012...
 * #   Scopes: drive, calendar
 * #   Password Mode: Single
 *
 * # Check authentication status (not authenticated)
 * proton-drive status
 * # Output:
 * # ✗ Not authenticated
 * #
 * # Run: proton-drive login
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
 * @since 0.1.0
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
          console.log(`  ${chalk.dim('User ID:')} ${session.uid}`);
          console.log(`  ${chalk.dim('Session ID:')} ${session.sessionId.substring(0, 20)}...`);
          console.log(`  ${chalk.dim('Scopes:')} ${session.scopes.join(', ')}`);
          console.log(`  ${chalk.dim('Password Mode:')} ${session.passwordMode === 1 ? 'Single' : 'Two-password'}`);
          console.log(`  ${chalk.dim('Auth Mode:')} ${session.authMode || 'srp'}`);
          if (session.authMode === 'browser-fork') {
            const keyPasswordStore = createKeyPasswordStore({
              provider: session.keyPasswordProvider,
              host: session.keyPasswordHost,
            });
            const keyPasswordAvailable = await keyPasswordStore.verify(session.uid);
            console.log(`  ${chalk.dim('Key Password:')} ${keyPasswordAvailable ? 'Stored' : 'Missing'}`);
          }
        } else {
          console.log(chalk.yellow('✗ Not authenticated'));
          console.log(chalk.dim('\nRun:'), chalk.bold('proton-drive login'));
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
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
 * # Safety Features
 *
 * - Uses POST /auth/v4/refresh endpoint (NOT a login attempt)
 * - Will never trigger CAPTCHA verification
 * - Will never trigger rate-limiting (refresh tokens have separate limits)
 * - Safe to call repeatedly (e.g., every 5 minutes by system tray)
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
 * proton-drive session refresh
 * echo $?
 * # Output: 0
 *
 * # Refresh with debug output
 * DEBUG=true proton-drive session refresh
 * # Output: (error details if refresh fails)
 *
 * # Use in system tray heartbeat (every 5 minutes)
 * # Cron: Run every 5 minutes
 * 5 * * * * /usr/local/bin/proton-drive session refresh
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage in system tray
 * import { createSessionRefreshCommand } from './cli/login';
 *
 * const program = new Command();
 * program.addCommand(createSessionRefreshCommand());
 *
 * // Heartbeat loop
 * setInterval(async () => {
 *   try {
 *     await program.parseAsync(['session', 'refresh'], { from: 'user' });
 *     console.log('Token refreshed');
 *   } catch (error) {
 *     console.error('Refresh failed:', error);
 *   }
 * }, 5 * 60 * 1000); // 5 minutes
 * ```
 *
 * @category CLI Commands
 * @see {@link createLoginCommand} for initial authentication
 * @see {@link AuthService.refreshSession} for underlying refresh logic
 * @see {@link SessionManager.getValidSession} for proactive token refresh
 * @since 0.1.0
 */
export function createSessionRefreshCommand(): Command {
  const command = new Command('session');

  command
    .command('refresh')
    .description('Refresh the access token (used by tray heartbeat)')
    .action(async () => {
      try {
        const session = await SessionManager.loadSession();
        if (!session) {
          // No session — nothing to refresh, silent success
          process.exit(0);
        }

        const authService = new AuthService();
        await authService.refreshSession();
        // Silent success
      } catch (error) {
        if (process.env.DEBUG === 'true') {
          handleError(error, true);
        }
        process.exit(1);
      }
    });

  return command;
}
