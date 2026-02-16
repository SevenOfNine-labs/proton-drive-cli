import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import { Writable } from 'stream';
import { createSDKClient } from '../sdk/client';
import { resolvePathToNodeUid } from '../sdk/pathResolver';
import { handleError } from '../errors/handler';
import { isVerbose, isQuiet, outputResult } from '../utils/output';
import { resolvePassword } from '../credentials';

/**
 * Create the download command for the CLI.
 *
 * Downloads a file from Proton Drive to the local filesystem with end-to-end encryption.
 * The file is decrypted locally after being downloaded from the server using OpenPGP.
 * Supports progress reporting and manifest signature verification for integrity checking.
 *
 * # Download Process
 *
 * 1. Resolves source path to node UID via Drive API
 * 2. Retrieves encrypted file chunks from Proton servers
 * 3. Verifies manifest signature (unless --skip-verification)
 * 4. Decrypts chunks locally using user's private key
 * 5. Writes decrypted data to output file
 *
 * # Signature Verification
 *
 * By default, the command verifies the file's manifest signature to ensure
 * integrity and authenticity. The `--skip-verification` flag disables this check
 * but is NOT recommended except for debugging or performance testing.
 *
 * # Progress Reporting
 *
 * - **Verbose mode**: Shows detailed progress (percentage, speed, ETA)
 * - **Quiet mode**: Outputs only the output path on success
 * - **Normal mode**: Outputs output path without progress details
 *
 * # Security Features
 *
 * - End-to-end decryption using OpenPGP after download
 * - Manifest signature verification (default enabled)
 * - Password resolved via credential provider (never logged)
 * - Secure stream processing (no full file in memory)
 *
 * # Exit Codes
 *
 * - 0: Download successful
 * - 1: Download failed (file not found, network error, decryption error, etc.)
 *
 * @returns Commander Command instance configured for download
 * @throws {AppError} FILE_NOT_FOUND - If source file doesn't exist in Drive
 * @throws {AppError} NETWORK_ERROR - If download from Proton API fails
 * @throws {AppError} DECRYPTION_ERROR - If file decryption fails
 * @throws {AppError} SIGNATURE_VERIFICATION_FAILED - If manifest signature is invalid
 * @throws {AppError} PERMISSION_DENIED - If user lacks read access to file
 *
 * @example
 * ```bash
 * # Download file from Drive
 * proton-drive download /Documents/file.pdf ./file.pdf
 *
 * # Download with verbose progress
 * proton-drive download /Photos/vacation.jpg ./vacation.jpg --verbose
 *
 * # Download without signature verification (not recommended)
 * proton-drive download /Backups/data.bin ./data.bin --skip-verification
 *
 * # Download with git-credential provider
 * proton-drive download /Documents/file.pdf ./file.pdf --credential-provider git-credential
 *
 * # Quiet mode (for scripts)
 * proton-drive download /file.txt ./file.txt --quiet
 * ```
 *
 * @example
 * ```typescript
 * // Programmatic usage
 * import { createDownloadCommand } from './cli/download';
 *
 * const program = new Command();
 * program.addCommand(createDownloadCommand());
 * await program.parseAsync(['download', '/Documents/file.pdf', './file.pdf'], { from: 'user' });
 * ```
 *
 * @category CLI Commands
 * @see {@link createUploadCommand} for uploading files
 * @see {@link resolvePathToNodeUid} for path resolution logic
 * @see {@link createSDKClient} for SDK client initialization
 * @since 0.1.0
 */
export function createDownloadCommand(): Command {
  return new Command('download')
    .description('Download a file from Proton Drive')
    .argument('<source>', 'Source path in Drive (e.g., /Documents/file.pdf)')
    .argument('<output>', 'Output path on local filesystem (e.g., ./file.pdf)')
    .option('--skip-verification', 'Skip manifest signature verification (not recommended)')
    .option('--password-stdin', 'Read password for key decryption from stdin')
    .option('--credential-provider <type>', 'Credential source: git-credential, pass-cli (default: interactive)')
    .action(downloadCommand);
}

async function downloadCommand(sourcePath: string, outputPath: string, options: any) {
  try {
    // Resolve password for key decryption
    const password = await resolvePassword(options);

    let initSpinner;
    if (isVerbose()) {
      initSpinner = ora('Initializing Drive client...').start();
    }

    const client = await createSDKClient(password);

    if (initSpinner) {
      initSpinner.succeed('Drive client initialized');
    }

    if (options.skipVerification && isVerbose()) {
      console.log(chalk.yellow('⚠ Skipping signature verification as requested'));
    }

    // Resolve source path to node UID
    const nodeUid = await resolvePathToNodeUid(client, sourcePath);

    // Download via SDK
    const startTime = Date.now();
    let lastUpdate = Date.now();
    let progressSpinner: any = null;

    const downloader = await client.getFileDownloader(nodeUid);
    const claimedSize = downloader.getClaimedSizeInBytes() || 0;

    const fileStream = (await import('fs')).createWriteStream(outputPath);
    const webStream = Writable.toWeb(fileStream) as WritableStream;

    const onProgress = (downloaded: number) => {
      if (!isVerbose()) return;

      const now = Date.now();
      if (now - lastUpdate >= 1000) {
        const total = claimedSize || downloaded;
        const progress = total > 0 ? (downloaded / total) * 100 : 0;
        const elapsed = (now - startTime) / 1000;
        const speed = elapsed > 0 ? downloaded / elapsed : 0;
        const remaining = total > 0 ? (total - downloaded) / speed : 0;

        const message =
          chalk.cyan('Downloading: ') +
          `${progress.toFixed(0)}% (${formatSize(downloaded)}/${formatSize(total)}) - ` +
          `${chalk.dim('Speed:')} ${formatSize(speed)}/s - ` +
          `${chalk.dim('Remaining:')} ${remaining.toFixed(0)}s`;

        if (!progressSpinner) {
          progressSpinner = ora(message).start();
        } else {
          progressSpinner.text = message;
        }

        lastUpdate = now;
      }
    };

    // Use unsafe download if skip-verification is requested
    const ctrl = options.skipVerification
      ? downloader.unsafeDownloadToStream(webStream, onProgress)
      : downloader.downloadToStream(webStream, onProgress);
    await ctrl.completion();

    if (progressSpinner) {
      progressSpinner.succeed(chalk.green('Download complete'));
    }

    const stat = await fs.stat(outputPath);
    const elapsedTime = (Date.now() - startTime) / 1000;
    const avgSpeed = stat.size / elapsedTime;

    if (isVerbose()) {
      console.log(chalk.green.bold('\n✓ Download successful!\n'));
      console.log(chalk.dim('Details:'));
      console.log(`  ${chalk.cyan('File:')} ${outputPath}`);
      console.log(`  ${chalk.cyan('Size:')} ${formatSize(stat.size)}`);
      console.log(`  ${chalk.cyan('Duration:')} ${formatTime(elapsedTime)}`);
      console.log(`  ${chalk.cyan('Avg Speed:')} ${formatSize(avgSpeed)}/s`);
    } else if (!isQuiet()) {
      outputResult(outputPath);
    }

  } catch (error) {
    handleError(error, process.env.DEBUG === 'true');
    process.exit(1);
  }
}

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
