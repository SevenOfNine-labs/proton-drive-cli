import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { extractFilenameFromPath, getParentPath, readStdinToTempFile } from './stdin';
import { ErrorCode } from '../errors/types';

describe('readStdinToTempFile', () => {
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

  function useStdin(chunks: string[], isTTY = false): void {
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(Readable.from(chunks), { isTTY }),
      configurable: true,
    });
  }

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
  });

  it('spools stdin into a private directory with a 0600 file and cleans both up', async () => {
    useStdin(['hello ', 'world']);

    const temp = await readStdinToTempFile();
    const dir = path.dirname(temp.path);
    expect(dir.startsWith(path.join(os.tmpdir(), 'proton-drive-upload-'))).toBe(true);
    expect(fs.readFileSync(temp.path, 'utf8')).toBe('hello world');
    if (process.platform !== 'win32') {
      expect(fs.statSync(temp.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }

    await temp.cleanup();
    expect(fs.existsSync(dir)).toBe(false);
    await expect(temp.cleanup()).resolves.toBeUndefined();
  });

  it('rejects empty input and removes the directory', async () => {
    useStdin([]);
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('proton-drive-upload-')));

    await expect(readStdinToTempFile()).rejects.toMatchObject({ code: ErrorCode.INVALID_FILE });

    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('proton-drive-upload-') && !before.has(n));
    expect(after).toEqual([]);
  });

  it('refuses to read from a terminal', async () => {
    useStdin(['x'], true);
    await expect(readStdinToTempFile()).rejects.toMatchObject({ code: ErrorCode.INVALID_FILE });
  });
});

describe('extractFilenameFromPath', () => {
  it('extracts filename from path', () => {
    expect(extractFilenameFromPath('/a/b.txt')).toBe('b.txt');
  });

  it('returns null for directory path (trailing slash)', () => {
    expect(extractFilenameFromPath('/a/')).toBeNull();
  });

  it('returns null for root path', () => {
    expect(extractFilenameFromPath('/')).toBeNull();
  });

  it('extracts filename with nested path', () => {
    expect(extractFilenameFromPath('/Documents/Projects/report.pdf')).toBe('report.pdf');
  });

  it('returns null for path without extension and no trailing slash', () => {
    // The function checks for a dot in the last part to determine if it's a filename
    expect(extractFilenameFromPath('/Documents/folder')).toBeNull();
  });
});

describe('getParentPath', () => {
  it('gets parent from file path', () => {
    expect(getParentPath('/a/b.txt')).toBe('/a');
  });

  it('returns path as-is for directory (trailing slash)', () => {
    expect(getParentPath('/a/')).toBe('/a');
  });

  it('returns root for root-level file', () => {
    expect(getParentPath('/b.txt')).toBe('/');
  });

  it('handles nested directory path', () => {
    expect(getParentPath('/Documents/Projects/')).toBe('/Documents/Projects');
  });
});
