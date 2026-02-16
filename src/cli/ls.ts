import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { NodeType } from '@protontech/drive-sdk';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function formatDate(timestamp: number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp * 1000);
  return date.toLocaleString();
}

function getNodeIcon(type: string): string {
  return type === NodeType.Folder ? '📁' : '📄';
}

/**
 * Create the ls command for the CLI.
 *
 * Lists files and folders in Proton Drive, similar to the Unix `ls` command.
 * Supports both simple and detailed (long) listing formats. Files are decrypted
 * locally to reveal their names and metadata before displaying.
 *
 * # Listing Modes
 *
 * **Simple mode** (default): Displays icon and name only
 * ```
 * 📁  Documents
 * 📁  Photos
 * 📄  readme.txt
 * ```
 *
 * **Long mode** (`-l` flag): Displays table with type, name, size, and modification time
 * ```
 * Type  Name        Size      Modified
 * 📁    Documents   -         2024-01-15 10:30:00
 * 📄    file.pdf    2.5 MB    2024-01-16 14:22:15
 * ```
 *
 * # Sorting Behavior
 *
 * - Folders listed before files
 * - Items within each group sorted alphabetically (case-insensitive)
 * - Mimics standard Unix ls behavior
 *
 * # Output Modes
 *
 * - **Verbose mode**: Shows table/list with icons and summary
 * - **Quiet mode**: Outputs names only (one per line, no formatting)
 * - **Normal mode**: Shows icons and names
 *
 * # Exit Codes
 *
 * - 0: Listing successful (includes empty folders)
 * - 1: Listing failed (path not found, permission denied, network error, etc.)
 *
 * @returns Commander Command instance configured for directory listing
 * @throws {AppError} FILE_NOT_FOUND - If path doesn't exist in Drive
 * @throws {AppError} NOT_A_FOLDER - If path points to a file instead of folder
 * @throws {AppError} NETWORK_ERROR - If API request fails
 * @throws {AppError} DECRYPTION_ERROR - If folder metadata decryption fails
 * @throws {AppError} PERMISSION_DENIED - If user lacks read access to folder
 *
 * @example
 * ```bash
 * # List root directory
 * proton-drive ls
 *
 * # List specific folder
 * proton-drive ls /Documents
 *
 * # Long listing format with details
 * proton-drive ls /Photos -l
 *
 * # Quiet mode (names only, for scripts)
 * proton-drive ls /Documents --quiet
 *
 * # List with git-credential provider
 * proton-drive ls / --credential-provider git-credential
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createLsCommand } from './cli/ls';
 *
 * const program = new Command();
 * program.addCommand(createLsCommand());
 * await program.parseAsync(['ls', '/Documents', '-l'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createMkdirCommand} for creating folders
 * @see {@link resolvePathToNodeUid} for path resolution logic
 * @see {@link createSDKClient} for SDK client initialization
 * @since 0.1.0
 */
export function createLsCommand(): Command {
  const cmd = new Command('ls');

  cmd
    .description('List files and folders in your Proton Drive')
    .argument('[path]', 'Path to list (defaults to root "/")', '/')
    .option('-l, --long', 'Use long listing format with details')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (path: string, options) => {
      try {
        // Resolve password for key decryption
        const password = await resolvePassword(options);

        // Create and initialize SDK client
        let spinner;
        if (isVerbose()) {
          spinner = ora('Loading folder contents...').start();
        }
        const client = await createSDKClient(password);

        // Resolve path to UID
        const folderUid = await resolvePathToNodeUid(client, path);

        // Collect children
        const nodes: Array<{
          name: string;
          type: string;
          size: number;
          modifyTime: Date;
        }> = [];

        for await (const child of client.iterateFolderChildren(folderUid)) {
          if (child.ok) {
            nodes.push({
              name: child.value.name,
              type: child.value.type,
              size: child.value.totalStorageSize || 0,
              modifyTime: child.value.modificationTime,
            });
          }
        }

        if (spinner) {
          spinner.stop();
        }

        if (nodes.length === 0) {
          if (isVerbose()) {
            console.log(chalk.yellow('\nFolder is empty.'));
          }
          return;
        }

        // Sort: folders first, then alphabetically
        nodes.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === NodeType.Folder ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        if (isVerbose()) {
          console.log(chalk.bold(`\nListing: ${path}\n`));

          if (options.long) {
            const table = new Table({
              head: [
                chalk.cyan('Type'),
                chalk.cyan('Name'),
                chalk.cyan('Size'),
                chalk.cyan('Modified'),
              ],
              style: { head: [], border: ['dim'] },
              colWidths: [6, 40, 12, 26],
            });

            for (const node of nodes) {
              const icon = getNodeIcon(node.type);
              const name = node.type === NodeType.Folder ? chalk.blue(node.name) : node.name;
              const size = node.type !== NodeType.Folder ? formatSize(node.size) : chalk.dim('-');
              const date = formatDate(node.modifyTime);
              table.push([icon, name, size, date]);
            }

            console.log(table.toString());
          } else {
            for (const node of nodes) {
              const icon = getNodeIcon(node.type);
              const name = node.type === NodeType.Folder ? chalk.blue(node.name) : node.name;
              console.log(`${icon}  ${name}`);
            }
          }

          const folders = nodes.filter((n) => n.type === NodeType.Folder).length;
          const files = nodes.filter((n) => n.type !== NodeType.Folder).length;
          console.log(chalk.dim(`\nTotal: ${nodes.length} items (${folders} folders, ${files} files)`));
        } else if (!isQuiet()) {
          for (const node of nodes) {
            outputResult(node.name);
          }
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return cmd;
}
