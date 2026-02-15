#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import { version as pkgVersion } from '../package.json';
import { createLoginCommand, createLogoutCommand, createStatusCommand, createSessionRefreshCommand } from './cli/login';
import { createLsCommand } from './cli/ls';
import { createUploadCommand } from './cli/upload';
import { createDownloadCommand } from './cli/download';
import { createMkdirCommand } from './cli/mkdir';
import { createBridgeCommand } from './cli/bridge';
import { createCredentialCommand } from './cli/credential';
import { createRmCommand } from './cli/rm';
import { createMvCommand } from './cli/mv';
import { createCatCommand } from './cli/cat';
import { createInfoCommand } from './cli/info';
import { setupShutdownHandlers } from './utils/shutdown';
import { handleError } from './errors/handler';
import { logger, LogLevel } from './utils/logger';

// Setup graceful shutdown handlers
setupShutdownHandlers();

// Suppress OpenPGP.js expected debug output (key derivation attempts).
// OpenPGP.js has no config option to control this; monkey-patch is necessary.
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  if (process.env.DEBUG === 'true') {
    originalConsoleError.apply(console, args);
    return;
  }
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('[OpenPGP.js debug]')) return;
  originalConsoleError.apply(console, args);
};

// Handle unhandled rejections
process.on('unhandledRejection', (error: unknown) => {
  handleError(error, process.env.DEBUG === 'true');
  process.exit(1);
});

// Handle uncaught exceptions (not covered by setupShutdownHandlers)
process.on('uncaughtException', (error: unknown) => {
  handleError(error, process.env.DEBUG === 'true');
  process.exit(1);
});

program
  .name('proton-drive')
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

    // Set debug mode
    if (opts.debug) {
      process.env.DEBUG = 'true';
      logger.setLevel(LogLevel.DEBUG);
    }

    // Set verbose mode
    if (opts.verbose) {
      process.env.VERBOSE = 'true';
    }

    // Set quiet mode (takes precedence)
    if (opts.quiet) {
      process.env.QUIET = 'true';
    }
  });

// Add authentication commands
program.addCommand(createLoginCommand());
program.addCommand(createLogoutCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionRefreshCommand());

// Add drive commands
program.addCommand(createLsCommand());
program.addCommand(createUploadCommand());
program.addCommand(createDownloadCommand());
program.addCommand(createMkdirCommand());

// Add file management commands
program.addCommand(createRmCommand());
program.addCommand(createMvCommand());
program.addCommand(createCatCommand());
program.addCommand(createInfoCommand());

// Add bridge command (for Git LFS integration)
program.addCommand(createBridgeCommand());

// Add credential management command
program.addCommand(createCredentialCommand());

// Custom help
program.on('--help', () => {
  console.log('');
  console.log(chalk.bold('Command Groups:'));
  console.log('');
  console.log(`  ${chalk.cyan('Authentication')}  login, logout, status, session refresh`);
  console.log(`  ${chalk.cyan('Credentials')}    credential store/remove/verify`);
  console.log(`  ${chalk.cyan('Drive')}          ls, upload, download, mkdir, rm, mv, cat, info`);
  console.log(`  ${chalk.cyan('Git LFS')}        bridge`);
  console.log('');
  console.log(chalk.bold('Credential Providers:'));
  console.log(`  ${chalk.dim('--credential-provider git-credential')}  macOS Keychain / Windows Credential Manager`);
  console.log(`  ${chalk.dim('--credential-provider pass-cli')}        Proton Pass CLI`);
  console.log('');
  console.log(chalk.bold('Examples:'));
  console.log('  $ proton-drive login');
  console.log('  $ proton-drive login --credential-provider pass-cli');
  console.log('  $ proton-drive credential store --provider pass-cli');
  console.log('  $ proton-drive credential verify --provider git-credential');
  console.log('  $ proton-drive upload ./file.pdf /Documents');
  console.log('  $ proton-drive ls /Documents');
  console.log('');
  console.log(chalk.dim('For more information on a specific command:'));
  console.log('  $ proton-drive <command> --help');
});

program.parse();
