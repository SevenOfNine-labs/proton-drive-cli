import { authTrace, maskIdentifier } from './auth-trace';
import { REDACTED_VALUE } from './redaction';

describe('auth trace', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('masks usernames without hiding useful routing context', () => {
    expect(maskIdentifier('assistant@vandriesten.eu')).toBe('as***t@vandriesten.eu');
    expect(maskIdentifier('agent.van-driesten')).toBe('ag***n');
    expect(maskIdentifier('xy')).toBe('**');
  });

  it('emits redacted JSON lines only when enabled', () => {
    delete process.env.PROTON_AUTH_TRACE;
    const writes: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    authTrace('auth.test', { password: 'secret' });
    expect(writes).toHaveLength(0);

    process.env.PROTON_AUTH_TRACE = '1';
    process.env.PROTON_AUTH_TRACE_ID = 'trace-123';
    authTrace('auth.test', {
      username: maskIdentifier('assistant@vandriesten.eu'),
      password: 'secret',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('[AUTH_TRACE]');
    const payload = JSON.parse(writes[0].replace('[AUTH_TRACE] ', ''));
    expect(payload).toMatchObject({
      traceId: 'trace-123',
      event: 'auth.test',
      username: 'as***t@vandriesten.eu',
      password: REDACTED_VALUE,
    });
  });
});
