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
 * Create the upload command
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
