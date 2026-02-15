import { Command } from 'commander';
import chalk from 'chalk';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create info command
 * Show metadata for a file or folder in Proton Drive
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
