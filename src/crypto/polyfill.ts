/**
 * TC39 "Uint8Array to/from base64 and hex" helpers (native from Node 25) for Node 22 and 24; only the
 * proposal module is loaded, since every bridge subprocess pays its load time.
 */
import 'core-js/proposals/array-buffer-base64';
