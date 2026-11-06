/** Bridge protocol exports (types, validators, OID paths) for src/cli/bridge.ts and its tests. */

export {
  BridgeRequest,
  BridgeResponse,

  OID_PATTERN,

  invalidRequest,
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
  errorToStatusCode,

  oidToPath,
  pathToOid,
} from './validators';

export {
  BRIDGE_AUTH_STATES,
  BRIDGE_COMMAND_REQUEST_FIELDS,
  BRIDGE_COMMANDS,
  BRIDGE_COMMON_REQUEST_FIELDS,
  BRIDGE_ERROR_DETAIL_FIELDS,
  BRIDGE_REQUEST_FIELDS,
  BRIDGE_RESPONSE_FIELDS,
  ERROR_CODE_STATUS,
  isBridgeCommand,
  statusCodeForErrorCode,
} from './protocol';

export type {
  BridgeAuthState,
  BridgeCommand,
  BridgeCommandRequestFields,
  BridgeRequestField,
} from './protocol';
