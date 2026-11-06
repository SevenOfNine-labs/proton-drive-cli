/**
 * Runtime implementation of the TC39 "Uint8Array to/from base64 and hex"
 * helpers (native from Node 25) for Node 22 and 24, where @protontech/crypto
 * and the Proton Drive SDK call `toBase64`, `fromBase64` and `toHex`. The
 * proposal module alone is loaded, not core-js/stable: every bridge
 * subprocess pays the load time. Declarations: src/types/uint8array-base64.d.ts.
 */
import 'core-js/proposals/array-buffer-base64';
