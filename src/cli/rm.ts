import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the rm command for the CLI.
 *
 * Removes files and folders from Proton Drive, similar to the Unix `rm` command.
 * By default, moves items to trash (recoverable). With `--permanent` flag, permanently
 * deletes items (non-recoverable). All deletion operations are performed server-side
 * after encrypted metadata verification.
 *
 * # Deletion Modes
 *
 * **Trash** (default): Moves item to trash bin (recoverable via web UI)
 * ```bash
 * proton-drive rm /Documents/file.pdf
 * ```
 *
 * **Permanent** (`--permanent` flag): Permanently deletes item (non-recoverable)
 * ```bash
 * proton-drive rm /Documents/file.pdf --permanent
 * ```
 *
 * # Deletion Process
 *
 * 1. Resolves path to node UID via Drive API
 * 2. Trash mode: Moves node to trash bin (recoverable)
 * 3. Permanent mode: Moves to trash, then permanently deletes
 * 4. Server marks encryption keys for deletion
 * 5. File content eventually purged from servers
 *
 * # Security Considerations
 *
 * - Permanent deletion is immediate and cannot be undone
 * - Encryption keys are destroyed (file becomes unrecoverable)
 * - Trash items can be restored via Proton Drive web interface
 * - Folder deletion recursively deletes all contents
 *
 * # Exit Codes
 *
 * - 0: Deletion successful
 * - 1: Deletion failed (path not found, permission denied, network error, etc.)
 *
 * @returns Commander Command instance configured for file/folder removal
 * @throws {AppError} FILE_NOT_FOUND - If path doesn't exist
 * @throws {AppError} NETWORK_ERROR - If API request fails
 * @throws {AppError} PERMISSION_DENIED - If user lacks delete permission
 * @throws {AppError} OPERATION_FAILED - If trash or permanent delete fails
 *
 * @example
 * ```bash
 * # Move file to trash (recoverable)
 * proton-drive rm /Documents/old-file.pdf
 *
 * # Permanently delete file (non-recoverable)
 * proton-drive rm /Documents/old-file.pdf --permanent
 *
 * # Delete folder (recursively deletes contents)
 * proton-drive rm /Old-Folder
 *
 * # Permanent folder deletion
 * proton-drive rm /Old-Folder --permanent
 *
 * # Delete with git-credential provider
 * proton-drive rm /file.pdf --credential-provider git-credential --permanent
 *
 * # Quiet mode (for scripts)
 * proton-drive rm /file.pdf --quiet
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createRmCommand } from './cli/rm';
 *
 * const program = new Command();
 * program.addCommand(createRmCommand());
 * await program.parseAsync(['rm', '/Documents/file.pdf', '--permanent'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createMvCommand} for moving files
 * @see {@link createLsCommand} for listing files
 * @see {@link resolvePathToNodeUid} for path resolution
 * @since 0.1.0
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
