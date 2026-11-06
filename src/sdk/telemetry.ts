/**
 * SDK telemetry that keeps stdout for the bridge envelope: logs go to the CLI logger (stderr) and
 * metrics to debug level, where the SDK's default ConsoleLogHandler would print to stdout.
 */

import type { Logger as SdkLogger, MetricEvent, Telemetry as SdkTelemetry } from '@protontech/drive-sdk';
import { logger } from '../utils/logger';

class CliSdkLogger implements SdkLogger {
  constructor(private readonly name: string) {}

  debug(message: string): void {
    logger.debug(`[sdk:${this.name}]`, message);
  }

  info(message: string): void {
    logger.info(`[sdk:${this.name}]`, message);
  }

  warn(message: string): void {
    logger.warn(`[sdk:${this.name}]`, message);
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) {
      logger.error(`[sdk:${this.name}]`, message);
      return;
    }
    logger.error(`[sdk:${this.name}]`, message, error instanceof Error ? error.message : error);
  }
}

/**
 * Create the telemetry object passed to ProtonDriveClient.
 */
export function createSdkTelemetry(): SdkTelemetry<MetricEvent> {
  return {
    getLogger(name: string): SdkLogger {
      return new CliSdkLogger(name);
    },
    recordMetric(event: MetricEvent): void {
      logger.debug('[sdk:metric]', event.eventName);
    },
  };
}
