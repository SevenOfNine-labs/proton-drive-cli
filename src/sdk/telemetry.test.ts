import { createSdkTelemetry } from './telemetry';
import { logger, LogLevel } from '../utils/logger';

describe('createSdkTelemetry', () => {
  const originalLevel = logger.getLevel();
  let stdoutWrite: jest.SpyInstance;
  let consoleError: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;
  let consoleInfo: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logger.setLevel(originalLevel);
    jest.restoreAllMocks();
  });

  it('never writes SDK logs or metrics to stdout', () => {
    logger.setLevel(LogLevel.DEBUG);
    const telemetry = createSdkTelemetry();
    const sdkLogger = telemetry.getLogger('upload');

    sdkLogger.debug('d');
    sdkLogger.info('i');
    sdkLogger.warn('w');
    sdkLogger.error('e', new Error('boom'));
    telemetry.recordMetric({ eventName: 'debounceLongWait' });

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[INFO]'), '[sdk:upload]', 'i');
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('[WARN]'), '[sdk:upload]', 'w');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'), '[sdk:upload]', 'e', 'boom');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'), '[sdk:metric]', 'debounceLongWait');
  });

  it('honours the CLI log level', () => {
    logger.setLevel(LogLevel.ERROR);
    const sdkLogger = createSdkTelemetry().getLogger('nodes');

    sdkLogger.info('hidden');
    sdkLogger.warn('hidden');
    sdkLogger.error('shown');

    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'), '[sdk:nodes]', 'shown');
  });
});
