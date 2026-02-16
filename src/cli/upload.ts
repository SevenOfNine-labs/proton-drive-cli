import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import { createSDKClient } from '../sdk/client';
import { ensureFolderPath } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { validateFilePath, validateFileSize } from '../utils/validation';
import { onShutdown, isShuttingDownFlag } from '../utils/shutdown';
import { AppError, ErrorCode } from '../errors/types';
import {
  isStdinPiped,
  readStdinToTempFile,
  cleanupTempFile,
  extractFilenameFromPath,
  getParentPath,
} from '../utils/stdin';
import { isVerbose, isQuiet, verboseLog, normalLog, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the upload command for the CLI.
 *
 * Uploads a local file or stdin data to Proton Drive with end-to-end encryption.
 * The file is encrypted locally before being sent to the server using OpenPGP.
 * Supports both regular file uploads and streaming from stdin for pipeline integration.
 *
 * # Upload Modes
 *
 * **File Upload**: Provide a local file path as the source
 * ```bash
 * proton-drive upload ./document.pdf /Documents
 * ```
 *
 * **Stdin Upload**: Use "-" as the source to read from stdin
 * ```bash
 * cat file.txt | proton-drive upload - /Documents/file.txt
 * echo "data" | proton-drive upload - /Documents --name file.txt
 * ```
 *
 * # Destination Path Behavior
 *
 * - **Folder destination**: `/Documents` → Uses original filename
 * - **Full path destination**: `/Documents/newname.pdf` → Uses specified filename
 * - **Stdin with --name**: Filename specified via flag
 * - **Stdin without --name**: Filename extracted from destination path
 *
 * # Progress Reporting
 *
 * - **Verbose mode**: Shows detailed progress (percentage, speed, ETA)
 * - **Quiet mode**: Outputs only the node UID on success
 * - **Normal mode**: Outputs node UID without progress details
 * - **--no-progress**: Disables progress reporting
 *
 * # Security Features
 *
 * - End-to-end encryption using OpenPGP before upload
 * - Password resolved via credential provider (never logged)
 * - Temporary files (stdin) cleaned up on both success and failure
 * - Graceful shutdown handling (SIGINT, SIGTERM) cleans up temp files
 *
 * # Exit Codes
 *
 * - 0: Upload successful
 * - 1: Upload failed (file not found, network error, encryption error, etc.)
 *
 * @returns Commander Command instance configured for upload
 * @throws {AppError} FILE_NOT_FOUND - If local file doesn't exist
 * @throws {AppError} FILE_TOO_LARGE - If file exceeds maximum size limit
 * @throws {AppError} INVALID_FILE - If stdin input is missing or invalid
 * @throws {AppError} NETWORK_ERROR - If upload to Proton API fails
 * @throws {AppError} ENCRYPTION_ERROR - If file encryption fails
 *
 * @example
 * ```bash
 * # Upload file to folder (keeps original filename)
 * proton-drive upload ./photo.jpg /Photos
 *
 * # Upload file with new name
 * proton-drive upload ./photo.jpg /Photos/vacation.jpg
 *
 * # Upload from stdin with filename in destination
 * cat large.bin | proton-drive upload - /Backups/large.bin
 *
 * # Upload from stdin with --name flag
 * tar czf - ./project | proton-drive upload - /Archives --name project.tar.gz
 *
 * # Disable progress output (for scripts)
 * proton-drive upload file.pdf /Documents --no-progress
 *
 * # Upload with git-credential provider
 * proton-drive upload file.pdf /Documents --credential-provider git-credential
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createUploadCommand } from './cli/upload';
 *
 * const program = new Command();
 * program.addCommand(createUploadCommand());
 * await program.parseAsync(['upload', './file.pdf', '/Documents'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createDownloadCommand} for downloading files
 * @see {@link validateFilePath} for file validation logic
 * @see {@link ensureFolderPath} for folder resolution
 * @since 0.1.0
 */
export function createUploadCommand(): Command {
  const cmd = new Command('upload');

  cmd
    .description('Upload a file to Proton Drive (use "-" to read from stdin)')
    .argument('<file>', 'Local file to upload (or "-" for stdin)')
    .argument('[destination]', 'Destination path in Drive - can be a folder (/Documents) or include filename (/Documents/newname.txt)', '/')
    .option('--no-progress', 'Disable progress output')
    .option('--name <filename>', 'Filename to use when uploading from stdin')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(async (file: string, destination: string, options) => {
      const startTime = Date.now();
      let uploadCancelled = false;
      let isStdin = false;
      let tempFilePath: string | null = null;
      let actualFilePath: string;
      let fileName: string;
      let uploadDestination: string;

      try {
        // Handle stdin upload
        if (file === '-') {
          isStdin = true;

          if (!isStdinPiped()) {
            throw new AppError(
              'No input provided. Please pipe data to stdin or provide a file path.',
              ErrorCode.INVALID_FILE,
              {},
              false
            );
          }

          const extractedFilename = extractFilenameFromPath(destination);

          if (extractedFilename) {
            fileName = extractedFilename;
            uploadDestination = getParentPath(destination);
          } else if (options.name) {
            fileName = options.name;
            uploadDestination = destination;
          } else {
            throw new AppError(
              'When uploading from stdin, you must either:\n' +
              '  1. Include filename in destination: proton-drive upload - /Documents/myfile.txt\n' +
              '  2. Use --name flag: proton-drive upload - /Documents --name myfile.txt',
              ErrorCode.VALIDATION_ERROR,
              {},
              false
            );
          }

          let spinner;
          if (isVerbose()) {
            spinner = ora('Reading from stdin...').start();
          }
          tempFilePath = await readStdinToTempFile();
          actualFilePath = tempFilePath;
          if (spinner) {
            spinner.succeed('Data received from stdin');
          }
        } else {
          await validateFilePath(file);
          actualFilePath = file;

          const extractedFilename = extractFilenameFromPath(destination);

          if (extractedFilename) {
            fileName = extractedFilename;
            uploadDestination = getParentPath(destination);
          } else {
            fileName = path.basename(file);
            uploadDestination = destination;
          }
        }

        const stats = await fs.stat(actualFilePath);
        validateFileSize(stats.size);
        const fileSize = stats.size;

        if (isVerbose()) {
          console.log(boxen(
            chalk.bold('Upload Details\n\n') +
            `${chalk.cyan('Source:')} ${isStdin ? 'stdin' : file}\n` +
            `${chalk.cyan('File:')} ${fileName}\n` +
            `${chalk.cyan('Size:')} ${formatBytes(fileSize)}\n` +
            `${chalk.cyan('Destination:')} ${uploadDestination}`,
            {
              padding: 1,
              borderColor: 'blue',
              borderStyle: 'round',
              margin: { top: 1, bottom: 1 }
            }
          ));
        }

        onShutdown(async () => {
          uploadCancelled = true;
          if (isVerbose()) {
            console.log(chalk.yellow('\n⚠️  Upload cancelled'));
          }
          if (tempFilePath) {
            await cleanupTempFile(tempFilePath);
          }
        });

        // Resolve password for key decryption
        const password = await resolvePassword(options);

        let initSpinner;
        if (isVerbose()) {
          initSpinner = ora('Initializing Drive client...').start();
        }
        const client = await createSDKClient(password);
        if (initSpinner) {
          initSpinner.succeed('Client initialized');
        }

        // Resolve parent folder to UID
        const parentUid = await ensureFolderPath(client, uploadDestination);

        // Upload file via SDK
        const fileStream = (await import('fs')).createReadStream(actualFilePath);
        const webStream = Readable.toWeb(fileStream) as ReadableStream;

        let progressSpinner: any = null;
        const onProgress = (uploaded: number) => {
          if (uploadCancelled || isShuttingDownFlag()) return;
          if (!options.progress || !isVerbose()) return;

          const progress = Math.floor((uploaded / fileSize) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = uploaded / elapsed;
          const remaining = (fileSize - uploaded) / speed;

          const message =
            chalk.cyan('Uploading: ') +
            `${progress}% (${formatBytes(uploaded)}/${formatBytes(fileSize)}) - ` +
            `${chalk.dim('Speed:')} ${formatBytes(speed)}/s - ` +
            `${chalk.dim('Remaining:')} ${formatTime(remaining)}`;

          if (!progressSpinner) {
            progressSpinner = ora(message).start();
          } else {
            progressSpinner.text = message;
          }
        };

        const uploader = await client.getFileUploader(parentUid, fileName, {
          mediaType: 'application/octet-stream',
          expectedSize: fileSize,
        });
        const ctrl = await uploader.uploadFromStream(webStream, [], onProgress);
        const { nodeUid } = await ctrl.completion();

        if (progressSpinner) {
          progressSpinner.succeed(chalk.green('Upload complete'));
        }

        if (tempFilePath) {
          await cleanupTempFile(tempFilePath);
        }

        const elapsedTime = (Date.now() - startTime) / 1000;
        const avgSpeed = fileSize / elapsedTime;

        if (isVerbose()) {
          console.log(chalk.green.bold('\n✓ Upload successful!\n'));
          console.log(chalk.dim('Details:'));
          console.log(`  ${chalk.cyan('Node UID:')} ${nodeUid}`);
          console.log(`  ${chalk.cyan('Duration:')} ${formatTime(elapsedTime)}`);
          console.log(`  ${chalk.cyan('Avg Speed:')} ${formatBytes(avgSpeed)}/s`);
        } else if (!isQuiet()) {
          outputResult(nodeUid);
        }
      } catch (error) {
        if (tempFilePath) {
          await cleanupTempFile(tempFilePath);
        }

        handleError(error, process.env.DEBUG === 'true');
        process.exit(1);
      }
    });

  return cmd;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}
