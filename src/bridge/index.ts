/**
 * Shared bridge exports for Git LFS integration.
 *
 * proton-drive-cli owns the bridge protocol (stdin/stdout JSON contract).
 * The Go adapter calls `node proton-drive-cli bridge <command>` directly,
 * and src/cli/bridge.ts imports these types, validators, and OID path helpers.
 */

export {
  // Types
  BridgeRequest,
  BridgeResponse,

  // Constants
  OID_PATTERN,

  // Validators
  validateOid,
  validateLocalPath,
  validateBridgeRequestForCommand,
  errorToStatusCode,

  // OID path mapping
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
