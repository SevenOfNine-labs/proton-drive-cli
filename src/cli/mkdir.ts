import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { ensureFolderPath } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the mkdir command for the CLI.
 *
 * Creates a new folder in Proton Drive with end-to-end encryption. The folder
 * name and metadata are encrypted locally before being sent to the server using
 * OpenPGP. Similar to the Unix `mkdir` command but for cloud storage.
 *
 * # Folder Creation Process
 *
 * 1. Resolves parent path to folder UID via Drive API
 * 2. Creates folder metadata (name, keys) and encrypts locally
 * 3. Sends encrypted folder node to Proton servers
 * 4. Returns the new folder's UID
 *
 * # Path Behavior
 *
 * - Parent path must exist (does not create parent directories automatically)
 * - To create nested folders, use multiple mkdir calls or create parent first
 * - Folder names are case-sensitive
 * - Duplicate folder names are allowed (Proton Drive supports duplicates)
 *
 * # Security Features
 *
 * - Folder name encrypted with parent's encryption key
 * - New folder receives its own encryption key
 * - All metadata encrypted before transmission
 * - Password resolved via credential provider (never logged)
 *
 * # Exit Codes
 *
 * - 0: Folder created successfully
 * - 1: Creation failed (parent not found, permission denied, network error, etc.)
 *
 * @returns Commander Command instance configured for folder creation
 * @throws {AppError} FILE_NOT_FOUND - If parent path doesn't exist
 * @throws {AppError} NOT_A_FOLDER - If parent path points to a file
 * @throws {AppError} NETWORK_ERROR - If API request fails
 * @throws {AppError} ENCRYPTION_ERROR - If folder metadata encryption fails
 * @throws {AppError} PERMISSION_DENIED - If user lacks write access to parent
 * @throws {AppError} QUOTA_EXCEEDED - If storage quota is full
 *
 * @example
 * ```bash
 * # Create folder in root
 * proton-drive mkdir / Documents
 *
 * # Create nested folder (parent must exist)
 * proton-drive mkdir /Documents Projects
 *
 * # Create folder with git-credential provider
 * proton-drive mkdir /Photos Vacation --credential-provider git-credential
 *
 * # Quiet mode (outputs only folder UID)
 * proton-drive mkdir /Backups 2024 --quiet
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createMkdirCommand } from './cli/mkdir';
 *
 * const program = new Command();
 * program.addCommand(createMkdirCommand());
 * await program.parseAsync(['mkdir', '/Documents', 'Projects'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createLsCommand} for listing folders
 * @see {@link createRmCommand} for deleting folders
 * @see {@link ensureFolderPath} for parent path resolution
 * @since 0.1.0
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
