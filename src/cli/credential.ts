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
