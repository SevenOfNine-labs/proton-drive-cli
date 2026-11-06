import { REDACTED_VALUE, redactSensitive, uidFingerprint } from './redaction';

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
      password: 'secret',
      keyPassword: 'derived-key-password',
      headers: {
        Authorization: 'Bearer access-token',
        'x-pm-uid': 'uid-123',
      },
      nested: {
        privateKey: 'armored-private-key',
      },
    }) as any;

    expect(redacted.password).toBe(REDACTED_VALUE);
    expect(redacted.keyPassword).toBe(REDACTED_VALUE);
    expect(redacted.headers.Authorization).toBe(REDACTED_VALUE);
    expect(redacted.headers['x-pm-uid']).toBe(REDACTED_VALUE);
    expect(redacted.nested.privateKey).toBe(REDACTED_VALUE);
  });

  it('keeps the provider and host that locate the key password', () => {
    expect(redactSensitive({
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    })).toEqual({
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    });
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

  it('masks the userinfo of a URL (RFC 3986, 3.2.1), as in git credential prompts', () => {
    expect(redactSensitive("could not read Password for 'https://uid-123@proton-drive-key.proton-lfs-cli.local': terminal prompts disabled"))
      .toBe(`could not read Password for 'https://${REDACTED_VALUE}@proton-drive-key.proton-lfs-cli.local': terminal prompts disabled`);
    expect(redactSensitive('https://proton-drive-key.proton-lfs-cli.local/path?q=a@b')).toBe('https://proton-drive-key.proton-lfs-cli.local/path?q=a@b');
  });

  it('fingerprints a session UID without revealing it', () => {
    expect(uidFingerprint('uid-123')).toMatch(/^[0-9a-f]{8}$/);
    expect(uidFingerprint('uid-123')).toBe(uidFingerprint('uid-123'));
    expect(uidFingerprint('uid-123')).not.toBe(uidFingerprint('uid-124'));
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
