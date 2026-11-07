/**
 * schemas/ is valid JSON Schema 2020-12 (Ajv strict mode), its data files match their schemas,
 * and the request fixtures agree with the runtime validator.
 */

import {
  assertValidAgainstSchema,
  compileSchema,
  createSchemaValidator,
  listDataFiles,
  listSchemaFiles,
  readJsonFile,
  schemaIdFor,
} from '../test/schema-validator';
import { BRIDGE_COMMANDS, BRIDGE_REQUEST_FIELDS } from './protocol';
import { validateBridgeRequestForCommand } from './validators';

const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

describe('schema files', () => {
  it('compiles every JSON Schema under schemas/ in strict mode', () => {
    const files = listSchemaFiles();
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const file of files) {
      expect(file.document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(file.document.$id).toBe(schemaIdFor(file.relativePath));
      expect(() => compileSchema(file.relativePath)).not.toThrow();
    }
  });

  it('validates each data file against its sibling schema', () => {
    const dataFiles = listDataFiles();
    expect(dataFiles.map((f) => f.relativePath).sort()).toEqual([
      'bridge/v1/error-code-map.json',
      'bridge/v1/request-field-rules.json',
    ]);
    for (const file of dataFiles) {
      expect(file.document.$id).toBe(schemaIdFor(file.relativePath));
      const schemaPath = file.relativePath.replace(/\.json$/, '.schema.json');
      expect(() => assertValidAgainstSchema(schemaPath, file.document)).not.toThrow();
    }
  });

  it('rejects a data file that drifts from its schema', () => {
    const contract = readJsonFile('bridge/v1/error-code-map.json') as { errorCodes: Record<string, unknown> };
    const drifted = { ...contract, errorCodes: { ...contract.errorCodes, lowercase_code: { httpStatus: 200, rootCode: 'x' } } };
    expect(() => assertValidAgainstSchema('bridge/v1/error-code-map.schema.json', drifted)).toThrow(/lowercase_code|propertyNames/);
  });

  it('ships one payload schema per bridge command', () => {
    for (const command of BRIDGE_COMMANDS) {
      expect(() => compileSchema(`bridge/v1/payloads/${command}.schema.json`)).not.toThrow();
    }
    const payloadFiles = listSchemaFiles()
      .filter((f) => f.relativePath.startsWith('bridge/v1/payloads/'))
      .map((f) => f.relativePath.replace('bridge/v1/payloads/', '').replace('.schema.json', ''));
    expect(payloadFiles.sort()).toEqual([...BRIDGE_COMMANDS].sort());
  });

  it('resolves the auth-state payload reference from the doctor report schema', () => {
    const ajv = createSchemaValidator();
    expect(ajv.getSchema(schemaIdFor('bridge/v1/auth-state-payload.schema.json'))).toBeDefined();
    const report = compileSchema('doctor/v1/report.schema.json');
    expect(report({
      ok: true,
      summary: { pass: 1, warn: 0, fail: 0, skip: 0 },
      authState: {
        state: 'needs_login',
        hasSession: false,
        sessionValid: false,
        sessionExpired: false,
        sessionUidPresent: false,
        credentialsAvailable: false,
        willAttemptNetwork: false,
        errors: [],
        actions: [],
      },
      canAttemptTransfer: false,
      canAttemptLiveCanary: true,
      checks: [{ id: 'x', title: 'x', status: 'pass', message: '' }],
    })).toBe(true);
  });
});

describe('request schema and runtime validator agree', () => {
  const requestSchema = () => compileSchema('bridge/v1/request.schema.json');

  it('accepts the root adapter request shapes', () => {
    const fixtures: Array<[string, Record<string, unknown>]> = [
      ['auth-state', {}],
      ['auth-state', { storageBase: 'LFS', appVersion: 'external-drive-protonlfscli@0.1.2' }],
      ['init', { storageBase: 'LFS' }],
      ['upload', { oid: VALID_OID, path: '/tmp/object', storageBase: 'LFS' }],
      ['download', { oid: VALID_OID, outputPath: '/tmp/object', storageBase: 'LFS' }],
      ['exists', { oid: VALID_OID }],
      ['delete', { oid: VALID_OID }],
      ['list', { folder: '/LFS/4d' }],
      ['batch-exists', { oids: [VALID_OID, VALID_OID.toUpperCase()] }],
      ['batch-delete', { oids: [VALID_OID] }],
    ];
    for (const [command, request] of fixtures) {
      expect(requestSchema()(request)).toBe(true);
      expect(() => validateBridgeRequestForCommand(command as any, request)).not.toThrow();
    }
  });

  it('rejects unknown fields and malformed OIDs', () => {
    const rejected = [
      { password: 'secret' },
      { dataCredentialProvider: 'pass-cli' },
      { oid: 'not-an-oid' },
      { oids: ['bad'] },
    ];
    for (const request of rejected) {
      expect(requestSchema()(request)).toBe(false);
    }
    expect(() => validateBridgeRequestForCommand('auth-state', { password: 'x' })).toThrow('Unknown bridge request field "password"');
    expect(() => validateBridgeRequestForCommand('upload', { oid: 'not-an-oid', path: '/tmp/x' })).not.toThrow();
  });

  it('exposes exactly the runtime request fields', () => {
    const schema = readJsonFile('bridge/v1/request.schema.json') as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual([...BRIDGE_REQUEST_FIELDS].sort());
    expect([...BRIDGE_REQUEST_FIELDS].sort()).toEqual(
      ['appVersion', 'folder', 'oid', 'oids', 'outputPath', 'path', 'storageBase'],
    );
    expect(BRIDGE_COMMANDS).not.toContain('refresh');
  });
});
