type HmacKeyUsage = 'sign' | 'verify';

function asArrayBuffer(data: Uint8Array): ArrayBuffer {
  return new Uint8Array(data).buffer as ArrayBuffer;
}

export async function importKey(
  key: Uint8Array,
  keyUsage: HmacKeyUsage[] = ['sign', 'verify'],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    asArrayBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    keyUsage as any,
  );
}

export async function signData(
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', key, asArrayBuffer(data));
  return new Uint8Array(signature);
}
