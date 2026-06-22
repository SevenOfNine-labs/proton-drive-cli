const mockCreateProvider = jest.fn();
const mockLoadSession = jest.fn();
const mockValidateSession = jest.fn();
const mockKeyPasswordVerify = jest.fn();
const mockNormalizeProviderName = jest.fn((name: string) => {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'git') return 'git-credential';
  if (normalized === 'pass') return 'pass-cli';
  if (['git-credential', 'pass-cli', 'stdin', 'interactive'].includes(normalized)) return normalized;
  throw new Error(`Unknown credential provider: ${name}`);
});

jest.mock('../credentials', () => ({
  createProvider: mockCreateProvider,
  normalizeProviderName: mockNormalizeProviderName,
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    getSessionFilePath: jest.fn(() => '/tmp/proton-session.json'),
    loadSession: mockLoadSession,
    validateSession: mockValidateSession,
  },
}));

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    provider: 'git-credential',
    host: 'proton-drive-key.proton-lfs-cli.local',
    verify: mockKeyPasswordVerify,
  })),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  stat: jest.fn(),
  readJson: jest.fn(),
}));

import * as fs from 'fs-extra';
import { createDoctorCommand, formatDoctorReport, runDoctor } from './doctor';

const mockFs = fs as jest.Mocked<typeof fs>;

function mockProvider(username: string = 'user@proton.me') {
  return {
    name: 'git-credential',
    isAvailable: jest.fn().mockResolvedValue(true),
    resolve: jest.fn().mockResolvedValue({ username, password: 'secret-password' }),
  };
}

function mockSession(passwordMode: number = 1) {
  return {
    sessionId: 'session-1',
    uid: 'uid-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['full'],
    passwordMode,
  };
}

describe('createDoctorCommand', () => {
  it('creates a doctor command with offline preflight options', () => {
    const cmd = createDoctorCommand();
    expect(cmd.name()).toBe('doctor');

    const optionNames = cmd.options.map((option: any) => option.long);
    expect(optionNames).toContain('--credential-provider');
    expect(optionNames).toContain('--data-credential-provider');
    expect(optionNames).toContain('--data-credential-host');
    expect(optionNames).toContain('--require-data-password');
    expect(optionNames).toContain('--drive-cli-bin');
    expect(optionNames).toContain('--session-file');
    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--strict');
  });
});

describe('runDoctor', () => {
  const driveCliBin = '/tmp/proton-drive-cli/dist/index.js';
  const sessionFile = '/tmp/proton-drive-cli/session.json';
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PROTON_DATA_PASSWORD;
    delete process.env.PROTON_SECOND_FACTOR_CODE;
    mockCreateProvider.mockReturnValue(mockProvider());
    mockLoadSession.mockResolvedValue(mockSession());
    mockValidateSession.mockResolvedValue(true);
    mockKeyPasswordVerify.mockResolvedValue(true);
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin || target === sessionFile);
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o600 });
    mockFs.readJson.mockResolvedValue(mockSession());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes when bridge binary, credentials, and secure session file are present', async () => {
    const report = await runDoctor({
      credentialProvider: 'git-credential',
      dataCredentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
      username: 'user@proton.me',
    });

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(5);
    expect(report.authState.state).toBe('ready');
    expect(report.authState.willAttemptNetwork).toBe(false);
    expect(report.canAttemptTransfer).toBe(true);
    expect(report.canAttemptLiveCanary).toBe(true);
    expect(mockValidateSession).toHaveBeenCalledWith(expect.objectContaining({ uid: 'uid-1' }), false);
    expect(mockCreateProvider).toHaveBeenCalledWith('git-credential', { host: 'proton.me' });
    expect(mockCreateProvider).toHaveBeenCalledWith('git-credential', {
      host: 'proton-data.proton-lfs-cli.local',
    });
  });

  it('fails when a required mailbox/data credential provider is missing', async () => {
    const report = await runDoctor({
      credentialProvider: 'git-credential',
      requireDataPassword: true,
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'data-credential',
        status: 'fail',
      }),
    ]));
  });

  it('fails when the session file permissions are too broad', async () => {
    (mockFs.stat as unknown as jest.Mock).mockResolvedValue({ mode: 0o644 });

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'session-file',
        status: 'fail',
        message: expect.stringContaining('too broad'),
      }),
    ]));
  });

  it('warns but passes when no saved session exists', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin);
    mockLoadSession.mockResolvedValue(null);

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(true);
    expect(report.authState.state).toBe('login_available');
    expect(report.canAttemptTransfer).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'session-file',
        status: 'warn',
      }),
    ]));
  });

  it('strict mode treats warnings as a non-zero result', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === driveCliBin);
    mockLoadSession.mockResolvedValue(null);

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
      strict: true,
    });

    expect(report.ok).toBe(false);
    expect(report.summary.warn).toBe(1);
    expect(report.canAttemptTransfer).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(false);
  });

  it('reports transfer blockers from the shared auth-state gate', async () => {
    mockFs.readJson.mockResolvedValue(mockSession(2));
    mockLoadSession.mockResolvedValue(mockSession(2));

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(true);
    expect(report.authState.state).toBe('needs_data_password');
    expect(report.canAttemptTransfer).toBe(false);
    expect(report.canAttemptLiveCanary).toBe(false);
  });

  it('fails when legacy secret environment variables are set', async () => {
    process.env.PROTON_DATA_PASSWORD = 'secret';

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'secret-env',
        status: 'fail',
      }),
    ]));
  });

  it('fails when the bridge entry point is missing', async () => {
    mockFs.pathExists.mockImplementation(async (target: string) => target === sessionFile);

    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'drive-cli-bin',
        status: 'fail',
      }),
    ]));
  });

  it('does not include resolved passwords in formatted output', async () => {
    const report = await runDoctor({
      credentialProvider: 'git-credential',
      driveCliBin,
      sessionFile,
    });

    expect(formatDoctorReport(report)).not.toContain('secret-password');
    expect(formatDoctorReport(report)).toContain('Auth state: ready');
    expect(formatDoctorReport(report)).toContain('Transfer: ready');
    expect(formatDoctorReport(report)).toContain('Live canary: ready');
  });
});
