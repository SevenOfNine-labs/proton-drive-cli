import { Command } from 'commander';
import chalk from 'chalk';
import * as pathLib from 'path';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid, ensureFolderPath } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create mv command
 * Move or rename a file or folder in Proton Drive
 */
export function createMvCommand(): Command {
  const mv = new Command('mv');

  mv
    .description('Move or rename a file or folder in Proton Drive')
    .argument('<source>', 'Source path (e.g., /Documents/old-name.pdf)')
    .argument('<destination>', 'Destination path (e.g., /Archive/new-name.pdf)')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (source: string, destination: string, options) => {
      try {
        const password = await resolvePassword(options);
        const client = await createSDKClient(password);

        if (isVerbose()) {
          console.log(chalk.cyan(`Moving "${source}" → "${destination}"...`));
        }

        const sourceUid = await resolvePathToNodeUid(client, source);

        const srcParent = pathLib.posix.dirname(source);
        const dstParent = pathLib.posix.dirname(destination);
        const srcName = pathLib.posix.basename(source);
        const dstName = pathLib.posix.basename(destination);

        const sameParent = srcParent === dstParent;

        if (sameParent) {
          // Pure rename
          if (srcName !== dstName) {
            await client.renameNode(sourceUid, dstName);
          }
        } else {
          // Move to different parent
          const newParentUid = await ensureFolderPath(client, dstParent);
          for await (const result of client.moveNodes([sourceUid], newParentUid)) {
            if (!result.ok) {
              throw new Error(`Failed to move: ${JSON.stringify(result.error)}`);
            }
          }

          // Rename if basename differs
          if (srcName !== dstName) {
            await client.renameNode(sourceUid, dstName);
          }
        }

        if (isVerbose()) {
          console.log(chalk.green(`✓ Moved: ${source} → ${destination}`));
        } else if (!isQuiet()) {
          outputResult(destination);
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return mv;
}
