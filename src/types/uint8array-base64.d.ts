/**
 * Types of the TC39 proposal "Uint8Array to/from base64 and hex" (https://tc39.es/proposal-arraybuffer-base64/);
 * runtime for Node 22 and 24 in src/crypto/polyfill.ts.
 */

type Uint8ArrayBase64Alphabet = 'base64' | 'base64url';

interface Uint8ArrayToBase64Options {
  alphabet?: Uint8ArrayBase64Alphabet;
  omitPadding?: boolean;
}

interface Uint8ArrayFromBase64Options {
  alphabet?: Uint8ArrayBase64Alphabet;
  lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial';
}

interface Uint8ArraySetFromResult {
  read: number;
  written: number;
}

interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  toBase64(options?: Uint8ArrayToBase64Options): string;
  toHex(): string;
  setFromBase64(string: string, options?: Uint8ArrayFromBase64Options): Uint8ArraySetFromResult;
  setFromHex(string: string): Uint8ArraySetFromResult;
}

interface Uint8ArrayConstructor {
  fromBase64(string: string, options?: Uint8ArrayFromBase64Options): Uint8Array<ArrayBuffer>;
  fromHex(string: string): Uint8Array<ArrayBuffer>;
}
