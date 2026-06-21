import { REDACTED_VALUE, redactSensitive } from './redaction';

describe('redactSensitive', () => {
  it('redacts Proton auth fields recursively while preserving safe metadata', () => {
    const input = {
      Code: 9001,
      Error: 'Human verification required',
      TokenType: 'Bearer',
      AccessToken: 'access-token',
      RefreshToken: 'refresh-token',
      UID: 'uid-123',
      Details: {
        WebUrl: 'https://verify.proton.me',
        HumanVerificationToken: 'hvt-123',
        HumanVerificationMethods: ['captcha'],
      },
      Requests: [
        {
          ClientEphemeral: 'client-eph',
          ClientProof: 'client-proof',
          SRPSession: 'srp-session',
          ServerProof: 'server-proof',
        },
      ],
    };

    const redacted = redactSensitive(input) as any;

    expect(redacted).toMatchObject({
      Code: 9001,
      Error: 'Human verification required',
      TokenType: 'Bearer',
      AccessToken: REDACTED_VALUE,
      RefreshToken: REDACTED_VALUE,
      UID: REDACTED_VALUE,
      Details: {
        WebUrl: 'https://verify.proton.me',
        HumanVerificationToken: REDACTED_VALUE,
        HumanVerificationMethods: ['captcha'],
      },
      Requests: [
        {
          ClientEphemeral: REDACTED_VALUE,
          ClientProof: REDACTED_VALUE,
          SRPSession: REDACTED_VALUE,
          ServerProof: REDACTED_VALUE,
        },
      ],
    });
  });

  it('redacts password-like and auth-header keys', () => {
    const redacted = redactSensitive({
      password: 'login-password',
      dataPassword: 'mailbox-password',
      headers: {
        Authorization: 'Bearer access-token',
        'x-pm-uid': 'uid-123',
      },
      nested: {
        privateKey: 'armored-private-key',
      },
    }) as any;

    expect(redacted.password).toBe(REDACTED_VALUE);
    expect(redacted.dataPassword).toBe(REDACTED_VALUE);
    expect(redacted.headers.Authorization).toBe(REDACTED_VALUE);
    expect(redacted.headers['x-pm-uid']).toBe(REDACTED_VALUE);
    expect(redacted.nested.privateKey).toBe(REDACTED_VALUE);
  });

  it('masks bearer and token assignment strings', () => {
    expect(redactSensitive('Authorization: Bearer abc.def-ghi')).toBe(
      `Authorization: Bearer ${REDACTED_VALUE}`
    );
    expect(redactSensitive('https://verify.proton.me/callback?token=abc123&other=ok')).toBe(
      `https://verify.proton.me/callback?token=${REDACTED_VALUE}&other=ok`
    );
    expect(redactSensitive('password=secret token=abc')).toBe(
      `password=${REDACTED_VALUE} token=${REDACTED_VALUE}`
    );
  });

  it('handles circular objects without throwing', () => {
    const input: any = { Code: 1000 };
    input.self = input;

    const redacted = redactSensitive(input) as any;

    expect(redacted).toEqual({
      Code: 1000,
      self: '[circular]',
    });
  });
});
