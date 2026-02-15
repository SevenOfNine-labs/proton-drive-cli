import { Command } from 'commander';
import { Writable } from 'stream';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { resolvePassword } from '../credentials';

/**
 * Create cat command
 * Stream file contents from Proton Drive to stdout
 */
export function createCatCommand(): Command {
  const cat = new Command('cat');

  cat
    .description('Stream file contents from Proton Drive to stdout')
    .argument('<path>', 'Path to the file in Proton Drive (e.g., /Documents/file.txt)')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (filePath: string, options) => {
      try {
        const password = await resolvePassword(options);
        const client = await createSDKClient(password);

        const nodeUid = await resolvePathToNodeUid(client, filePath);
        const downloader = await client.getFileDownloader(nodeUid);
        const webStream = Writable.toWeb(process.stdout) as WritableStream;

        const ctrl = downloader.downloadToStream(webStream);
        await ctrl.completion();
      } catch (error) {
        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return cat;
}
