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
  errorToStatusCode,

  // OID path mapping
  oidToPath,
  pathToOid,
} from './validators';
