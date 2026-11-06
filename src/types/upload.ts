export interface UploadOptions {
  filePath: string;
  destinationPath: string;
  mimeType?: string;
  onProgress?: (uploaded: number, total: number) => void;
}

export interface FileBlock {
  index: number;
  data: Uint8Array;
  hash: string; // SHA256 hash
  size: number;
  encryptedData?: Uint8Array;
  encryptedSignature?: string;
}

export interface FileRevision {
  revisionId: string;
  state: number;
  size: number;
  manifestSignature: string;
}

export interface UploadResult {
  fileId: string;
  revisionId: string;
  size: number;
  uploadedBlocks: number;
}

export const BLOCK_SIZE = 4 * 1024 * 1024; // 4MB
export const MAX_PARALLEL_BLOCKS = 4; // Based on CPU count in C# SDK
