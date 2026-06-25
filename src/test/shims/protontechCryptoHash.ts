function asArrayBuffer(data: Uint8Array): ArrayBuffer {
  return new Uint8Array(data).buffer as ArrayBuffer;
}

export async function computeSHA256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', asArrayBuffer(data));
  return new Uint8Array(digest);
}
