import { Command } from 'commander';
import chalk from 'chalk';
import * as pathLib from 'path';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid, ensureFolderPath } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the mv command for the CLI.
 *
 * Moves or renames files and folders in Proton Drive with end-to-end encryption.
 * Combines Unix `mv` behavior (move + rename) into a single command. All metadata
 * changes are encrypted locally before being sent to the server.
 *
 * # Operation Modes
 *
 * **Rename** (same parent): Changes only the node name
 * ```bash
 * proton-drive mv /Documents/old.pdf /Documents/new.pdf
 * ```
 *
 * **Move** (different parent): Changes parent folder, optionally rename
 * ```bash
 * proton-drive mv /Documents/file.pdf /Archive/file.pdf
 * proton-drive mv /Documents/file.pdf /Archive/renamed.pdf
 * ```
 *
 * # Move Process
 *
 * 1. Resolves source path to node UID
 * 2. Determines if operation is rename, move, or both
 * 3. If moving: Updates parent folder reference
 * 4. If renaming: Encrypts new name and updates node metadata
 * 5. Returns the new destination path
 *
 * # Security Features
 *
 * - All metadata updates encrypted before transmission
 * - New name encrypted with parent folder's key
 * - Original file content remains unchanged
 * - Password resolved via credential provider (never logged)
 *
 * # Exit Codes
 *
 * - 0: Move/rename successful
 * - 1: Operation failed (source not found, permission denied, network error, etc.)
 *
 * @returns Commander Command instance configured for move/rename
 * @throws {AppError} FILE_NOT_FOUND - If source path doesn't exist
 * @throws {AppError} FILE_NOT_FOUND - If destination parent doesn't exist
 * @throws {AppError} NETWORK_ERROR - If API request fails
 * @throws {AppError} ENCRYPTION_ERROR - If name encryption fails
 * @throws {AppError} PERMISSION_DENIED - If user lacks write access
 * @throws {AppError} DUPLICATE_NAME - If destination already exists (behavior may vary)
 *
 * @example
 * ```bash
 * # Rename file in same folder
 * proton-drive mv /Documents/report.pdf /Documents/final-report.pdf
 *
 * # Move file to different folder (keep name)
 * proton-drive mv /Documents/photo.jpg /Photos/photo.jpg
 *
 * # Move and rename simultaneously
 * proton-drive mv /Downloads/file.bin /Archive/backup.bin
 *
 * # Rename folder
 * proton-drive mv /Old-Folder /New-Folder
 *
 * # Move with git-credential provider
 * proton-drive mv /Documents/file.pdf /Archive/file.pdf --credential-provider git-credential
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createMvCommand } from './cli/mv';
 *
 * const program = new Command();
 * program.addCommand(createMvCommand());
 * await program.parseAsync(['mv', '/Documents/old.pdf', '/Archive/new.pdf'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createRmCommand} for deleting files
 * @see {@link createMkdirCommand} for creating folders
 * @see {@link resolvePathToNodeUid} for path resolution
 * @since 0.1.0
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
