import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create rm command
 * Remove a file or folder from Proton Drive
 */
export function createRmCommand(): Command {
  const rm = new Command('rm');

  rm
    .description('Remove a file or folder from Proton Drive')
    .argument('<path>', 'Path to the file or folder to remove (e.g., /Documents/file.pdf)')
    .option('--permanent', 'Permanently delete (skip trash)')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (targetPath: string, options) => {
      try {
        const password = await resolvePassword(options);
        const client = await createSDKClient(password);

        if (isVerbose()) {
          console.log(chalk.cyan(`Removing "${targetPath}"...`));
        }

        const nodeUid = await resolvePathToNodeUid(client, targetPath);

        // Trash the node
        for await (const result of client.trashNodes([nodeUid])) {
          if (!result.ok) {
            throw new Error(`Failed to trash: ${JSON.stringify(result.error)}`);
          }
        }

        // Permanently delete if requested
        if (options.permanent) {
          for await (const result of client.deleteNodes([nodeUid])) {
            if (!result.ok) {
              throw new Error(`Failed to permanently delete: ${JSON.stringify(result.error)}`);
            }
          }
        }

        if (isVerbose()) {
          const action = options.permanent ? 'Permanently deleted' : 'Moved to trash';
          console.log(chalk.green(`✓ ${action}: ${targetPath}`));
        } else if (!isQuiet()) {
          outputResult(options.permanent ? 'deleted' : 'trashed');
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return rm;
}
