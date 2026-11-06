/** CLI logger: every level writes to stderr; stdout carries only command results (bridge envelope, --json). */

import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  debug(...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.error(chalk.dim('[DEBUG]'), ...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.error(chalk.blue('[INFO]'), ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(chalk.yellow('[WARN]'), ...args);
    }
  }

  error(...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(chalk.red('[ERROR]'), ...args);
    }
  }

  success(...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.error(chalk.green('[SUCCESS]'), ...args);
    }
  }
}

export const logger = new Logger();

if (process.env.DEBUG) {
  logger.setLevel(LogLevel.DEBUG);
}
