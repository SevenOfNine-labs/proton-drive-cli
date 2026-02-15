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
 * Create the ls command
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
