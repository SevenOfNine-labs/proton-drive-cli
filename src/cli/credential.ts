/**
 * `proton-drive credential` subcommand.
 *
 * Manages credentials via a configurable provider:
 *   --provider git-credential  (default) — macOS Keychain, Windows Credential Manager, etc.
 *   --provider pass-cli        — Proton Pass CLI
 *
 * Subcommands:
 *   store  - Store credentials in the configured provider
 *   remove - Remove credentials from the configured provider
 *   verify - Verify that credentials can be resolved
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  createProvider,
  normalizeProviderName,
  readPasswordFromStdin,
  gitCredentialFill,
  gitCredentialApprove,
  gitCredentialReject,
} from '../credentials';
import type { ProviderName } from '../credentials';
import { handleError } from '../errors/handler';
import { isQuiet, outputResult } from '../utils/output';
import { PROTON_CREDENTIAL_HOST } from '../constants';

function getProviderName(options: { provider?: string }): ProviderName {
  if (options.provider) {
    return normalizeProviderName(options.provider);
  }
  return 'git-credential';
}

/**
 * Create the credential command for the CLI.
 *
 * Manages Proton Drive credentials via configurable credential providers.
 * Supports storing, removing, and verifying credentials in secure system stores
 * like macOS Keychain, Windows Credential Manager, Linux Secret Service, or Proton Pass.
 *
 * # Credential Providers
 *
 * **git-credential** (default): Uses Git Credential Manager
 * - macOS: Stores in Keychain
 * - Windows: Stores in Credential Manager
 * - Linux: Stores in Secret Service (libsecret)
 * - Protocol: https://account.proton.me
 *
 * **pass-cli**: Uses Proton Pass CLI
 * - Searches all vaults for proton.me login entry
 * - Supports multi-vault setups
 * - Requires pass-cli to be installed and authenticated
 *
 * # Subcommands
 *
 * **store**: Store credentials in the configured provider
 * ```bash
 * proton-drive credential store -u user@proton.me
 * echo "password" | proton-drive credential store -u user@proton.me --password-stdin
 * ```
 *
 * **remove**: Remove credentials from the configured provider
 * ```bash
 * proton-drive credential remove -u user@proton.me
 * ```
 *
 * **verify**: Verify that credentials can be resolved
 * ```bash
 * proton-drive credential verify --provider git-credential
 * proton-drive credential verify --provider pass-cli
 * ```
 *
 * # Security Features
 *
 * - Passwords never accepted via CLI flags (only --password-stdin or interactive)
 * - Credentials stored in OS-native secure stores
 * - No plaintext credentials in config files or environment variables
 * - Password masking in interactive prompts
 *
 * # Exit Codes
 *
 * - 0: Operation successful
 * - 1: Operation failed (provider error, credential not found, network error, etc.)
 *
 * @returns Commander Command instance configured for credential management
 * @throws {AppError} CREDENTIAL_NOT_FOUND - If credentials don't exist (verify)
 * @throws {AppError} PROVIDER_ERROR - If credential provider fails
 * @throws {AppError} INVALID_INPUT - If required parameters missing
 *
 * @example
 * ```bash
 * # Store credentials via git-credential (default)
 * proton-drive credential store -u user@proton.me
 * # (prompts for password interactively)
 *
 * # Store with piped password (for scripts)
 * echo "password" | proton-drive credential store -u user@proton.me --password-stdin
 *
 * # Store via Proton Pass CLI
 * proton-drive credential store --provider pass-cli
 *
 * # Verify credentials exist
 * proton-drive credential verify
 * # Output: Credentials found via git-credential:
 * #   Username: user@proton.me
 * #   Password: ********************
 *
 * # Remove credentials
 * proton-drive credential remove -u user@proton.me
 *
 * # Verify with specific provider
 * proton-drive credential verify --provider pass-cli
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createCredentialCommand } from './cli/credential';
 *
 * const program = new Command();
 * program.addCommand(createCredentialCommand());
 * await program.parseAsync(['credential', 'store', '-u', 'user@proton.me'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createLoginCommand} for authentication
 * @see {@link createProvider} for provider implementations
 * @see {@link gitCredentialFill} for git-credential resolution
 * @since 0.1.0
 */
export function createCredentialCommand(): Command {
  const cmd = new Command('credential');
  cmd.description('Manage credentials (git-credential or pass-cli)');

  // --- store ---
  cmd
    .command('store')
    .description('Store Proton credentials')
    .option('-u, --username <account>', 'Proton email or username')
    .option('--password-stdin', 'Read password from stdin')
    .option('--host <host>', 'Credential host', PROTON_CREDENTIAL_HOST)
    .option('--provider <type>', 'Credential provider: git-credential (default), pass-cli')
    .action(async (options) => {
      try {
        const providerName = getProviderName(options);
        let username = options.username;
        let password: string | undefined;

        // Read password from stdin if flagged
        if (options.passwordStdin || !process.stdin.isTTY) {
          password = await readPasswordFromStdin();
        }

        // Interactive prompts for missing fields
        if (!username || !password) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            if (!username) console.error(chalk.red('Error: --username is required in non-interactive mode'));
            if (!password) console.error(chalk.red('Error: --password-stdin is required in non-interactive mode'));
            process.exit(1);
          }

          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'username',
              message: 'Proton email or username:',
              when: !username,
              validate: (input: string) => input.length > 0 || 'Email or username is required',
            },
            {
              type: 'password',
              name: 'password',
              message: 'Password:',
              when: !password,
              mask: '*',
              validate: (input: string) => input.length > 0 || 'Password is required',
            },
          ]);

          username = username || answers.username;
          password = password || answers.password;
        }

        // Use provider-specific store
        const provider = createProvider(providerName, { host: options.host });
        if (provider.store) {
          await provider.store(username!, password!);
        } else {
          // Fallback for providers that don't support store directly
          await gitCredentialApprove({
            protocol: 'https',
            host: options.host,
            username: username!,
            password: password!,
          });
        }

        if (!isQuiet()) {
          outputResult(`Credentials stored for ${username} via ${providerName}`);
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  // --- remove ---
  cmd
    .command('remove')
    .description('Remove Proton credentials')
    .option('-u, --username <account>', 'Proton email or username')
    .option('--host <host>', 'Credential host', PROTON_CREDENTIAL_HOST)
    .option('--provider <type>', 'Credential provider: git-credential (default), pass-cli')
    .action(async (options) => {
      try {
        const providerName = getProviderName(options);
        let username = options.username;

        if (!username) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error(chalk.red('Error: --username is required in non-interactive mode'));
            process.exit(1);
          }

          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'username',
              message: 'Proton email or username to remove:',
              validate: (input: string) => input.length > 0 || 'Email or username is required',
            },
          ]);
          username = answers.username;
        }

        const provider = createProvider(providerName, { host: options.host });
        if (provider.remove) {
          await provider.remove(username);
        } else {
          await gitCredentialReject({
            protocol: 'https',
            host: options.host,
            username,
            password: '',
          });
        }

        if (!isQuiet()) {
          outputResult(`Credentials removed for ${username} via ${providerName}`);
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  // --- verify ---
  cmd
    .command('verify')
    .description('Verify that credentials can be resolved')
    .option('--host <host>', 'Credential host', PROTON_CREDENTIAL_HOST)
    .option('--provider <type>', 'Credential provider: git-credential (default), pass-cli')
    .action(async (options) => {
      try {
        const providerName = getProviderName(options);
        const provider = createProvider(providerName, { host: options.host });

        if (provider.verify) {
          const ok = await provider.verify();
          if (!ok) {
            console.error(chalk.red(`No credentials found via ${providerName}`));
            process.exit(1);
          }
        }

        // Resolve to show details
        const cred = await provider.resolve();

        if (!isQuiet()) {
          console.log(chalk.green(`Credentials found via ${providerName}:`));
          console.log(`  ${chalk.dim('Username:')} ${cred.username}`);
          console.log(`  ${chalk.dim('Password:')} ${'*'.repeat(20)}`);
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return cmd;
}
