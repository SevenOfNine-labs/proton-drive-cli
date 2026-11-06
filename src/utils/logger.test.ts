import { logger, LogLevel } from './logger';

describe('logger', () => {
  const originalLevel = logger.getLevel();

  afterEach(() => {
    logger.setLevel(originalLevel);
    jest.restoreAllMocks();
  });

  it('writes every level to stderr and nothing to stdout', () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.setLevel(LogLevel.DEBUG);

    logger.debug('d');
    logger.info('i');
    logger.success('s');
    logger.warn('w');
    logger.error('e');

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(4);
  });

  it('filters by level', () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.setLevel(LogLevel.WARN);

    logger.info('hidden');
    logger.warn('shown');

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('[WARN]'), 'shown');
  });
});
