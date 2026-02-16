import { Command } from 'commander';
import { Writable } from 'stream';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { resolvePassword } from '../credentials';

/**
 * Create the cat command for the CLI.
 *
 * Streams file contents from Proton Drive to stdout, similar to the Unix `cat` command.
 * The file is downloaded and decrypted on-the-fly, streaming chunks directly to stdout
 * without writing to disk. Ideal for viewing text files or piping into other commands.
 *
 * # Streaming Process
 *
 * 1. Resolves file path to node UID via Drive API
 * 2. Downloads encrypted chunks from Proton servers
 * 3. Decrypts chunks on-the-fly using OpenPGP
 * 4. Streams decrypted data directly to stdout
 * 5. No intermediate files created on disk
 *
 * # Use Cases
 *
 * **View text file**: Displays file content in terminal
 * ```bash
 * proton-drive cat /Documents/readme.txt
 * ```
 *
 * **Pipe to other commands**: Integrates with Unix pipelines
 * ```bash
 * proton-drive cat /Logs/app.log | grep ERROR
 * proton-drive cat /Data/config.json | jq .
 * proton-drive cat /Archives/backup.tar.gz | tar xzf -
 * ```
 *
 * **Redirect to file**: Save to local filesystem
 * ```bash
 * proton-drive cat /Documents/file.pdf > local-copy.pdf
 * ```
 *
 * # Security Features
 *
 * - End-to-end decryption using OpenPGP
 * - No temporary files created (direct streaming)
 * - Manifest signature verification (integrity check)
 * - Password resolved via credential provider (never logged)
 *
 * # Exit Codes
 *
 * - 0: File streamed successfully
 * - 1: Streaming failed (file not found, network error, decryption error, etc.)
 *
 * @returns Commander Command instance configured for file streaming
 * @throws {AppError} FILE_NOT_FOUND - If file path doesn't exist
 * @throws {AppError} IS_A_FOLDER - If path points to a folder instead of file
 * @throws {AppError} NETWORK_ERROR - If download fails
 * @throws {AppError} DECRYPTION_ERROR - If file decryption fails
 * @throws {AppError} SIGNATURE_VERIFICATION_FAILED - If manifest signature is invalid
 * @throws {AppError} PERMISSION_DENIED - If user lacks read access
 *
 * @example
 * ```bash
 * # View text file
 * proton-drive cat /Documents/readme.txt
 *
 * # Pipe to grep (search logs)
 * proton-drive cat /Logs/app.log | grep ERROR
 *
 * # Pipe to jq (parse JSON)
 * proton-drive cat /Config/settings.json | jq .database
 *
 * # Extract tar archive directly from Drive
 * proton-drive cat /Archives/backup.tar.gz | tar xzf -
 *
 * # Save to local file
 * proton-drive cat /Documents/report.pdf > local-report.pdf
 *
 * # Use with git-credential provider
 * proton-drive cat /file.txt --credential-provider git-credential
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createCatCommand } from './cli/cat';
 *
 * const program = new Command();
 * program.addCommand(createCatCommand());
 * await program.parseAsync(['cat', '/Documents/file.txt'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createDownloadCommand} for saving files to disk
 * @see {@link createUploadCommand} for uploading files
 * @see {@link resolvePathToNodeUid} for path resolution
 * @since 0.1.0
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
