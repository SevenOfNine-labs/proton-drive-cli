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
 * Create the login command for the CLI
 * Handles user authentication with Proton Drive
 *
 * Credential sources (in priority order):
 * 1. --credential-provider git (resolves both username + password via git credential)
 * 2. --password-stdin (piped password — safe from `ps` and /proc leaks)
 * 3. -u/--username flag (username only — not sensitive)
 * 4. Interactive prompts (if TTY is available)
 *
 * Passwords are NEVER accepted via CLI flags or environment variables.
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
 * Create the logout command for the CLI
 * Clears the current session
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
 * Create the status command for the CLI
 * Shows current authentication status
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
 * Designed for headless use by the system tray heartbeat:
 * - Silent on success (exit 0)
 * - Silent exit 0 if no session exists (nothing to refresh)
 * - Error message + exit 1 on failure
 *
 * This calls POST /auth/v4/refresh (NOT a login attempt) —
 * it will never trigger CAPTCHA or rate-limiting.
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
