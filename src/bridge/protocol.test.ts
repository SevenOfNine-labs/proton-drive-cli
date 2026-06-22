import * as fs from 'fs';
import * as path from 'path';
import {
  BRIDGE_AUTH_STATES,
  BRIDGE_ERROR_DETAIL_FIELDS,
  BRIDGE_REQUEST_FIELDS,
  BRIDGE_RESPONSE_FIELDS,
  ERROR_CODE_STATUS,
} from './protocol';
import { ErrorCode } from '../errors/types';

function readContract(name: string): any {
  const file = path.resolve(__dirname, '..', '..', 'schemas', 'bridge', 'v1', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('bridge protocol contract', () => {
  it('keeps request schema fields aligned with runtime constants', () => {
    const schema = readContract('request.schema.json');
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(BRIDGE_REQUEST_FIELDS));
    expect(schema.additionalProperties).toBe(false);
  });

  it('keeps response envelope schema fields aligned with runtime constants', () => {
    const schema = readContract('response-envelope.schema.json');
    const successFields = Object.keys(schema.oneOf[0].properties);
    const failureFields = Object.keys(schema.oneOf[1].properties);
    expect(sorted(successFields)).toEqual(sorted(BRIDGE_RESPONSE_FIELDS));
    expect(sorted(failureFields)).toEqual(sorted(BRIDGE_RESPONSE_FIELDS));
  });

  it('keeps auth-state schema enum aligned with runtime constants', () => {
    const schema = readContract('auth-state-payload.schema.json');
    expect(sorted(schema.properties.state.enum)).toEqual(sorted(BRIDGE_AUTH_STATES));
    expect(schema.properties.willAttemptNetwork.const).toBe(false);
  });

  it('keeps error details schema aligned with runtime error codes', () => {
    const schema = readContract('error-details.schema.json');
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(BRIDGE_ERROR_DETAIL_FIELDS));
    expect(sorted(schema.properties.errorCode.enum)).toEqual(sorted(Object.values(ErrorCode)));
  });

  it('keeps error-code map aligned with ErrorCode and status constants', () => {
    const contract = readContract('error-code-map.json');
    const contractCodes = Object.keys(contract.errorCodes);
    expect(sorted(contractCodes)).toEqual(sorted(Object.values(ErrorCode)));
    expect(sorted(Object.keys(ERROR_CODE_STATUS))).toEqual(sorted(Object.values(ErrorCode)));

    for (const code of Object.values(ErrorCode)) {
      expect(contract.errorCodes[code].httpStatus).toBe(ERROR_CODE_STATUS[code]);
      expect(typeof contract.errorCodes[code].rootCode).toBe('string');
    }
  });
});
