import {
  BridgeRequest,
  BridgeResponse,
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
  errorToStatusCode,
  oidToPath,
  pathToOid,
  OID_PATTERN,
  BRIDGE_COMMAND_REQUEST_FIELDS,
  isBridgeCommand,
} from './index';

const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

describe('shared bridge exports', () => {
  it('exports OID_PATTERN that matches valid OIDs', () => {
    expect(OID_PATTERN.test(VALID_OID)).toBe(true);
    expect(OID_PATTERN.test(VALID_OID.toUpperCase())).toBe(true);
  });

  it('OID_PATTERN rejects invalid OIDs', () => {
    expect(OID_PATTERN.test('too-short')).toBe(false);
    expect(OID_PATTERN.test('g'.repeat(64))).toBe(false);
    expect(OID_PATTERN.test(VALID_OID + 'a')).toBe(false);
  });

  it('exports validateOid', () => {
    expect(() => validateOid(VALID_OID)).not.toThrow();
    expect(() => validateOid('bad')).toThrow();
  });

  it('exports validateLocalPath', () => {
    expect(() => validateLocalPath('/tmp/file.txt')).not.toThrow();
    expect(() => validateLocalPath('../etc/passwd')).toThrow('Path traversal');
  });

  it('exports command request validation helpers', () => {
    expect(isBridgeCommand('auth-state')).toBe(true);
    expect(isBridgeCommand('not-a-command')).toBe(false);
    expect(BRIDGE_COMMAND_REQUEST_FIELDS.upload.required).toContain('oid');
    expect(() => validateBridgeRequestForCommand('upload', {
      oid: VALID_OID,
      path: '/tmp/file.txt',
    })).not.toThrow();
  });

  it('exports errorToStatusCode', () => {
    expect(typeof errorToStatusCode({ message: 'not found' })).toBe('number');
  });

  it('exports oidToPath', () => {
    const p = oidToPath('LFS', VALID_OID);
    expect(p).toBe(`/LFS/4d/7a/${VALID_OID}`);
  });

  it('exports pathToOid', () => {
    const oid = pathToOid(`/LFS/4d/7a/${VALID_OID}`);
    expect(oid).toBe(VALID_OID);
  });

  it('BridgeRequest type is usable', () => {
    const req: BridgeRequest = { username: 'test', password: 'pass' };
    expect(req.username).toBe('test');
  });

  it('BridgeResponse type is usable', () => {
    const res: BridgeResponse = { ok: true, payload: {} };
    expect(res.ok).toBe(true);
  });
});
