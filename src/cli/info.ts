import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the info command for the CLI.
 *
 * Displays detailed metadata for a file or folder in Proton Drive. The metadata
 * is decrypted locally using the user's private key before being displayed. Useful
 * for inspecting file properties, verification, and debugging.
 *
 * # Metadata Displayed
 *
 * - **Name**: Decrypted node name
 * - **Type**: "file" or "folder"
 * - **Size**: Total storage size in bytes (encrypted size)
 * - **UID**: Unique node identifier
 * - **Created**: Creation timestamp (ISO 8601 format)
 * - **Modified**: Last modification timestamp (ISO 8601 format)
 *
 * # Output Modes
 *
 * **Verbose mode**: Human-readable formatted display with labels
 * ```
 * Info: /Documents/file.pdf
 *
 *   Name:     file.pdf
 *   Type:     file
 *   Size:     1024000 bytes
 *   UID:      abc123xyz
 *   Created:  2024-01-15T10:30:00.000Z
 *   Modified: 2024-01-16T14:22:15.000Z
 * ```
 *
 * **Normal mode**: JSON output (for scripting/parsing)
 * ```json
 * {"name":"file.pdf","type":"file","size":1024000,"uid":"abc123xyz","created":"2024-01-15T10:30:00.000Z","modified":"2024-01-16T14:22:15.000Z"}
 * ```
 *
 * # Exit Codes
 *
 * - 0: Metadata retrieved successfully
 * - 1: Operation failed (path not found, permission denied, network error, etc.)
 *
 * @returns Commander Command instance configured for metadata display
 * @throws {AppError} FILE_NOT_FOUND - If path doesn't exist
 * @throws {AppError} NETWORK_ERROR - If API request fails
 * @throws {AppError} DECRYPTION_ERROR - If metadata decryption fails
 * @throws {AppError} PERMISSION_DENIED - If user lacks read access
 *
 * @example
 * ```bash
 * # Show file metadata (verbose mode)
 * proton-drive info /Documents/report.pdf --verbose
 *
 * # Show folder metadata
 * proton-drive info /Photos
 *
 * # JSON output for parsing (normal mode)
 * proton-drive info /file.txt | jq .size
 *
 * # Use with git-credential provider
 * proton-drive info /Documents/file.pdf --credential-provider git-credential
 *
 * # Quiet mode (no output)
 * proton-drive info /file.txt --quiet
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createInfoCommand } from './cli/info';
 *
 * const program = new Command();
 * program.addCommand(createInfoCommand());
 * await program.parseAsync(['info', '/Documents/file.pdf'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createLsCommand} for listing directory contents
 * @see {@link resolvePathToNodeUid} for path resolution
 * @see {@link createSDKClient} for SDK client initialization
 * @since 0.1.0
 */
export function createInfoCommand(): Command {
  const info = new Command('info');

  info
    .description('Show metadata for a file or folder in Proton Drive')
    .argument('<path>', 'Path to the file or folder (e.g., /Documents/file.pdf)')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (targetPath: string, options) => {
      try {
        const password = await resolvePassword(options);
        const client = await createSDKClient(password);

        const nodeUid = await resolvePathToNodeUid(client, targetPath);
        const node = await client.getNode(nodeUid);

        if (!node.ok) {
          throw new Error(`Failed to get node info: ${JSON.stringify(node.error)}`);
        }

        const meta = node.value;

        if (isVerbose()) {
          console.log(chalk.bold(`\nInfo: ${targetPath}\n`));
          console.log(`  ${chalk.cyan('Name:')}     ${meta.name}`);
          console.log(`  ${chalk.cyan('Type:')}     ${meta.type}`);
          console.log(`  ${chalk.cyan('Size:')}     ${meta.totalStorageSize || 0} bytes`);
          console.log(`  ${chalk.cyan('UID:')}      ${meta.uid}`);
          if (meta.creationTime) {
            console.log(`  ${chalk.cyan('Created:')}  ${meta.creationTime.toISOString()}`);
          }
          if (meta.modificationTime) {
            console.log(`  ${chalk.cyan('Modified:')} ${meta.modificationTime.toISOString()}`);
          }
        } else if (!isQuiet()) {
          outputResult(JSON.stringify({
            name: meta.name,
            type: meta.type,
            size: meta.totalStorageSize || 0,
            uid: meta.uid,
            created: meta.creationTime?.toISOString() || null,
            modified: meta.modificationTime?.toISOString() || null,
          }));
        }
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return info;
}
