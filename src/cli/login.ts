import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { AuthService } from '../auth';
import { SessionManager } from '../auth/session';
import { promptForToken } from '../auth/captcha-helper';
import { CaptchaError } from '../errors/types';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { readPasswordFromStdin, resolveCredentials, normalizeProviderName, createProvider } from '../credentials';

/**
 * Create the login command for the CLI.
 *
 * Authenticates with Proton Drive using the SRP (Secure Remote Password) protocol.
 * The command supports multiple credential input methods and includes CAPTCHA handling
 * for enhanced security. Successful authentication creates a session with access and
 * refresh tokens stored in ~/.proton-drive-cli/session.json.
 *
 * Credential sources are prioritized in this order:
 * 1. `--credential-provider git` - Resolves both username and password via Git Credential Manager
 * 2. `--credential-provider pass-cli` - Resolves credentials from Proton Pass vault
 * 3. `--password-stdin` - Reads password from stdin (safe from process listing leaks)
 * 4. `-u/--username` flag - Username only (password must come from another source)
 * 5. Interactive prompts - If TTY is available, prompts for missing credentials
 *
 * # Security Features
 *
 * - Passwords are NEVER accepted via CLI flags or environment variables
 * - Session reuse: Skips login if already authenticated as the same user
 * - CAPTCHA support: Automatically prompts for verification token when required
 * - Secure storage: Only session tokens are persisted (never passwords)
 * - Process isolation: Credentials passed via stdin to child processes
 *
 * # Exit Codes
 *
 * - 0: Login successful or already authenticated
 * - 1: Authentication failed (invalid credentials, network error, CAPTCHA failed)
 *
 * @returns Commander Command instance configured for login
 *
 * @example
 * ```bash
 * # Interactive login (prompts for username and password)
 * proton-drive login
 *
 * # Login with username flag (prompts for password)
 * proton-drive login -u user@proton.me
 *
 * # Login with piped password (for scripts)
 * echo "password" | proton-drive login -u user@proton.me --password-stdin
 *
 * # Login via Git Credential Manager
 * proton-drive login --credential-provider git-credential
 *
 * # Login via Proton Pass CLI
 * proton-drive login --credential-provider pass-cli
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
 * @see {@link AuthService.login} for underlying authentication logic
 * @since 0.1.0
 */
export function createLoginCommand(): Command {
  const command = new Command('login');

  command
    .description('Authenticate with Proton Drive')
    .option('-u, --username <email|username>', 'Proton account email or username')
    .option('--password-stdin', 'Read password from stdin (for scripts with special characters)')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (options) => {
      try {
        let username = options.username;
        let password: string | undefined;

        // Handle --credential-provider (git-credential, pass-cli, etc.)
        if (options.credentialProvider) {
          const name = normalizeProviderName(options.credentialProvider);
          const provider = createProvider(name);
          const creds = await provider.resolve({ username });
          username = creds.username || username;
          password = creds.password;
          if (!isQuiet()) {
            console.log(chalk.dim(`[INFO] Credentials resolved via ${name} for ${username}`));
          }
        }

        // Handle --password-stdin flag or detect piped stdin
        if (!password && (options.passwordStdin || !process.stdin.isTTY)) {
          try {
            password = await readPasswordFromStdin();
            if (!isQuiet()) {
              console.log(chalk.dim('[INFO] Password read from stdin'));
            }
          } catch (err) {
            console.error(chalk.red('Error reading password from stdin:'), err);
            process.exit(1);
          }
        }

        // Session reuse: skip login if already authenticated as this user.
        // If username is known, check if the session belongs to the same user.
        // If the session belongs to a different user, fall through to re-login.
        try {
          if (username) {
            if (await SessionManager.isSessionForUser(username)) {
              if (!isQuiet()) {
                console.log('Already authenticated. Log out first to log in again.');
              } else {
                outputResult('OK');
              }
              return;
            }
          } else {
            // No username yet (will prompt interactively) — just check session exists
            const authCheck = new AuthService();
            if (await authCheck.isAuthenticated()) {
              if (!isQuiet()) {
                console.log('Already authenticated. Log out first to log in again.');
              } else {
                outputResult('OK');
              }
              return;
            }
          }
        } catch {
          // Session file corrupted or unreadable — fall through to login
        }

        if (!username || !password) {
          // Check if we can prompt interactively
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            // Non-interactive mode - can't prompt
            if (!username) {
              console.error(chalk.red('Error: Username required.'));
              console.error(chalk.dim('Use -u flag or run interactively.'));
            }
            if (!password) {
              console.error(chalk.red('Error: Password required.'));
              console.error(chalk.dim('Use --password-stdin or run interactively.'));
            }
            console.error(chalk.dim('\nExamples:'));
            console.error(chalk.dim('  echo "password" | proton-drive login -u user@example.com --password-stdin'));
            console.error(chalk.dim('  proton-drive login   # interactive prompts'));
            process.exit(1);
          }

          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'username',
              message: 'Email or username:',
              when: !username,
              validate: (input: string) => {
                if (!input || input.trim().length === 0) {
                  return 'Please enter your Proton email or username';
                }
                return true;
              },
            },
            {
              type: 'password',
              name: 'password',
              message: 'Password:',
              when: !password,
              mask: '*',
              validate: (input: string) => {
                if (!input || input.length < 1) {
                  return 'Password is required';
                }
                return true;
              },
            },
          ]);

          username = username || answers.username;
          password = password || answers.password;
        }

        // At this point both username and password are guaranteed defined
        const finalUsername = username as string;
        const finalPassword = password as string;

        // Authenticate with spinner
        let spinner;
        if (isVerbose()) {
          spinner = ora('Authenticating...').start();
        }
        const authService = new AuthService();

        try {
          await authService.login(finalUsername.trim(), finalPassword);
          if (spinner) {
            spinner.succeed(chalk.green('Login successful!'));
          }
          if (isVerbose()) {
            console.log(chalk.dim('Session saved (tokens only — password is not stored on disk).'));
            console.log('\nYou can now use the CLI to upload files to Proton Drive.');
          } else if (!isQuiet()) {
            outputResult('OK');
          }
        } catch (error: unknown) {
          if (spinner) {
            spinner.stop();
          }

          // CAPTCHA required — capture verification token
          if (error instanceof CaptchaError) {
            if (isVerbose()) {
              console.log(chalk.dim(`  Verification methods: ${error.verificationMethods.join(', ') || 'none'}`));
              console.log(chalk.dim(`  Challenge token: ${error.captchaToken}`));
              console.log(chalk.dim(`  URL: ${error.captchaUrl}`));
            }

            const verificationToken = await promptForToken(
              error.captchaUrl,
              error.captchaToken
            );

            if (!verificationToken) {
              console.error(chalk.red('No verification token received. Login cancelled.'));
              process.exit(1);
            }

            // Retry login with the captured token
            const verifySpinner = ora('Retrying authentication with verification token...').start();
            try {
              await authService.login(finalUsername.trim(), finalPassword, verificationToken);
              verifySpinner.succeed(chalk.green('Login successful!'));
              if (isVerbose()) {
                console.log(chalk.dim('Session saved (tokens only).'));
              } else if (!isQuiet()) {
                outputResult('OK');
              }
            } catch (retryError: unknown) {
              verifySpinner.fail();
              throw retryError;
            }
            return;
          } else {
            throw error;
          }
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return command;
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
