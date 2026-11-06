#!/usr/bin/env node
import './crypto/polyfill';
import { program } from 'commander';
import chalk from 'chalk';
import { version as pkgVersion } from '../package.json';
import { createLoginCommand, createLogoutCommand, createStatusCommand, createSessionRefreshCommand } from './cli/login';
import { createLsCommand } from './cli/ls';
import { createUploadCommand } from './cli/upload';
import { createDownloadCommand } from './cli/download';
import { createMkdirCommand } from './cli/mkdir';
import { createBridgeCommand } from './cli/bridge';
import { createDoctorCommand } from './cli/doctor';
import { createRmCommand } from './cli/rm';
import { createMvCommand } from './cli/mv';
import { createCatCommand } from './cli/cat';
import { createInfoCommand } from './cli/info';
import { setupShutdownHandlers } from './utils/shutdown';
import { handleError } from './errors/handler';
import { logger, LogLevel } from './utils/logger';

setupShutdownHandlers();

process.on('unhandledRejection', (error: unknown) => {
  handleError(error, process.env.DEBUG === 'true');
  process.exit(1);
});

process.on('uncaughtException', (error: unknown) => {
  handleError(error, process.env.DEBUG === 'true');
  process.exit(1);
});

program
  .name('proton-drive-cli')
  .description(
    chalk.blue.bold('Proton Drive CLI') +
    '\n\nUpload and manage files in Proton Drive from the command line.'
  )
  .version(pkgVersion, '-v, --version', 'Display version')
  .option('-d, --debug', 'Enable debug output')
  .option('--verbose', 'Show detailed output (default is minimal for scripting)')
  .option('-q, --quiet', 'Suppress all non-error output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();

    if (opts.debug) {
      process.env.DEBUG = 'true';
      logger.setLevel(LogLevel.DEBUG);
    }

    if (opts.verbose) {
      process.env.VERBOSE = 'true';
    }

    // Quiet output wins over --verbose (utils/output.ts).
    if (opts.quiet) {
      process.env.QUIET = 'true';
    }
  });

program.addCommand(createLoginCommand());
program.addCommand(createLogoutCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionRefreshCommand());

program.addCommand(createLsCommand());
program.addCommand(createUploadCommand());
program.addCommand(createDownloadCommand());
program.addCommand(createMkdirCommand());

program.addCommand(createRmCommand());
program.addCommand(createMvCommand());
program.addCommand(createCatCommand());
program.addCommand(createInfoCommand());

program.addCommand(createBridgeCommand());

program.addCommand(createDoctorCommand());

program.on('--help', () => {
  console.log('');
  console.log(chalk.bold('Command Groups:'));
  console.log('');
  console.log(`  ${chalk.cyan('Authentication')}  login, logout, status, session refresh`);
  console.log(`  ${chalk.cyan('Preflight')}      doctor`);
  console.log(`  ${chalk.cyan('Drive')}          ls, upload, download, mkdir, rm, mv, cat, info`);
  console.log(`  ${chalk.cyan('Git LFS')}        bridge`);
  console.log('');
  console.log(chalk.bold('Key Password Providers:'));
  console.log(`  ${chalk.dim('--key-password-provider pass-cli')}        Proton Pass CLI (default)`);
  console.log(`  ${chalk.dim('--key-password-provider git-credential')}  macOS Keychain / Windows Credential Manager`);
  console.log('');
  console.log(chalk.bold('Examples:'));
  console.log('  $ proton-drive-cli login');
  console.log('  $ proton-drive-cli login --key-password-provider git-credential');
  console.log('  $ proton-drive-cli doctor');
  console.log('  $ proton-drive-cli upload ./file.pdf /Documents');
  console.log('  $ proton-drive-cli ls /Documents');
  console.log('');
  console.log(chalk.dim('For more information on a specific command:'));
  console.log('  $ proton-drive-cli <command> --help');
});

// Action handlers are async: parseAsync awaits them so their rejections reach
// the handlers above instead of being dropped by a synchronous parse().
program.parseAsync().catch((error: unknown) => {
  handleError(error, process.env.DEBUG === 'true');
  process.exitCode = 1;
});
