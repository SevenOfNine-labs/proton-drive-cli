import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { ensureFolderPath } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create mkdir command
 * Creates a new folder in Proton Drive
 */
export function createMkdirCommand(): Command {
  const mkdir = new Command('mkdir');

  mkdir
    .description('Create a new folder in Proton Drive')
    .argument('<path>', 'Path where to create the folder (e.g., /Documents)')
    .argument('<folder-name>', 'Name of the folder to create')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (path: string, folderName: string, options) => {
      try {
        // Resolve password for key decryption
        const password = await resolvePassword(options);

        // Initialize SDK client
        const client = await createSDKClient(password);

        if (isVerbose()) {
          console.log(chalk.cyan(`Creating folder "${folderName}" at ${path}...`));
        }

        // Create the folder using SDK
        const parentUid = await ensureFolderPath(client, path);
        const result = await client.createFolder(parentUid, folderName);
        if (!result.ok) {
          throw new Error(`Failed to create folder: ${JSON.stringify(result.error)}`);
        }

        if (isVerbose()) {
          console.log(chalk.green('✓ Folder created successfully'));
          console.log(chalk.gray(`  Folder UID: ${result.value.uid}`));
          console.log(chalk.gray(`  Full path: ${path}/${folderName}`));
        } else if (!isQuiet()) {
          outputResult(result.value.uid);
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return mkdir;
}
