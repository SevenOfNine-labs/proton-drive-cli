/**
 * Telemetry adapter for the Proton Drive SDK.
 *
 * Without a `telemetry` option the SDK falls back to its ConsoleLogHandler and
 * ConsoleMetricHandler, which print INFO logs and metrics through console.info
 * and console.log, i.e. to stdout. The bridge contract reserves stdout for the
 * single JSON envelope, so the SDK is given this adapter instead: log records
 * are forwarded to the CLI logger (stderr, filtered by the CLI log level) and
 * metrics are only recorded at debug level.
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
