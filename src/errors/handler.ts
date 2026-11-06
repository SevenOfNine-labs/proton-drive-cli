import chalk from 'chalk';
import { toAppError } from './classify';
import { redactSensitive } from '../utils/redaction';

/**
 * Handle and format error for CLI display
 */
export function handleError(error: unknown, debug: boolean = false): void {
  const appError = toAppError(error);

  // Display main error message
  console.error(chalk.red.bold('\n✗ Error:'), appError.toUserMessage());

  // Show recovery suggestion
  const suggestion = appError.getRecoverySuggestion();
  if (suggestion) {
    console.error(chalk.yellow('\n💡 Suggestion:'), suggestion);
  }

  // Show recovery hint for temporary errors
  if (appError.isRecoverable && !suggestion) {
    console.error(chalk.yellow('\n💡 This error may be temporary. Please try again.'));
  }

  // Show details in debug mode
  if (debug) {
    console.error(chalk.dim('\n📋 Debug Information:'));
    console.error(chalk.dim('  Error Code:'), appError.code);
    console.error(chalk.dim('  Technical Message:'), appError.message);
    console.error(chalk.dim('  Recoverable:'), appError.isRecoverable);

    if (appError.details && Object.keys(appError.details).length > 0) {
      console.error(chalk.dim('  Details:'));
      console.error(chalk.dim(JSON.stringify(redactSensitive(appError.details), null, 4)));
    }

    if (appError.stack) {
      console.error(chalk.dim('\n📚 Stack Trace:'));
      console.error(chalk.dim(appError.stack));
    }
  } else {
    console.error(chalk.dim('\n💻 Run with --debug for detailed error information'));
  }
}
