import { NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';
import { ensureFolderPath, findFileInFolder, findFileNodeInFolder, resolvePathToNodeUid } from './pathResolver';
import { ErrorCode, PathNotFoundError } from '../errors/types';

jest.mock('../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

interface FakeNode {
  uid: string;
  name: string;
  type: NodeType;
  activeRevision?: { uid: string };
}

/**
 * In-memory folder tree: children[parentUid] lists the nodes the SDK would
 * yield from iterateFolderChildren(parentUid).
 */
function makeClient(children: Record<string, FakeNode[]>) {
  const client = {
    getMyFilesRootFolder: jest.fn(async () => ({ uid: 'root' })),
    iterateFolderChildren: jest.fn(async function* (parentUid: string) {
      for (const node of children[parentUid] ?? []) {
        yield { uid: node.uid, type: node.type, name: { ok: true, value: node.name }, activeRevision: node.activeRevision };
      }
    }),
    createFolder: jest.fn(async (parentUid: string, name: string) => {
      const uid = `${parentUid}/${name}`;
      children[parentUid] = [...(children[parentUid] ?? []), { uid, name, type: NodeType.Folder }];
      return { uid };
    }),
  };
  return client;
}

describe('resolvePathToNodeUid', () => {
  it('walks the tree and returns the leaf uid', async () => {
    const client = makeClient({
      root: [{ uid: 'root/LFS', name: 'LFS', type: NodeType.Folder }],
      'root/LFS': [{ uid: 'root/LFS/4d', name: '4d', type: NodeType.Folder }],
    });
    await expect(resolvePathToNodeUid(client as any, '/LFS/4d/')).resolves.toBe('root/LFS/4d');
  });

  it('throws a typed PathNotFoundError naming the missing segment', async () => {
    const client = makeClient({ root: [{ uid: 'root/LFS', name: 'LFS', type: NodeType.Folder }] });
    const error = await resolvePathToNodeUid(client as any, '/LFS/zz').catch((e) => e);
    expect(error).toBeInstanceOf(PathNotFoundError);
    expect(error).toMatchObject({ code: ErrorCode.PATH_NOT_FOUND, path: '/LFS/zz', missingSegment: 'zz' });
    expect(client.createFolder).not.toHaveBeenCalled();
  });

  it('rejects traversal and NUL bytes as INVALID_PATH', async () => {
    const client = makeClient({});
    await expect(resolvePathToNodeUid(client as any, '/LFS/../etc')).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
    await expect(ensureFolderPath(client as any, '/LFS/a\0b')).rejects.toMatchObject({ code: ErrorCode.INVALID_PATH });
  });
});

describe('ensureFolderPath', () => {
  it('creates every missing segment in one traversal', async () => {
    const client = makeClient({ root: [] });
    await expect(ensureFolderPath(client as any, '/LFS/4d/7a')).resolves.toBe('root/LFS/4d/7a');
    expect(client.createFolder.mock.calls).toEqual([
      ['root', 'LFS'],
      ['root/LFS', '4d'],
      ['root/LFS/4d', '7a'],
    ]);
    expect(client.getMyFilesRootFolder).toHaveBeenCalledTimes(1);
  });

  it('continues with existingNodeUid when a concurrent process created the folder first', async () => {
    const client = makeClient({ root: [] });
    client.createFolder.mockRejectedValueOnce(new NodeWithSameNameExistsValidationError('exists', 2500, 'root/LFS-by-other'));

    await expect(ensureFolderPath(client as any, '/LFS/4d')).resolves.toBe('root/LFS-by-other/4d');
    expect(client.createFolder).toHaveBeenCalledTimes(2);
    expect(client.createFolder).toHaveBeenLastCalledWith('root/LFS-by-other', '4d');
  });

  it('re-lists the parent when the SDK reports the conflict without a node uid', async () => {
    const tree: Record<string, FakeNode[]> = { root: [] };
    const client = makeClient(tree);
    client.createFolder.mockImplementationOnce(async () => {
      // The other process wins between our listing and our create.
      tree.root.push({ uid: 'root/LFS-by-other', name: 'LFS', type: NodeType.Folder });
      throw new NodeWithSameNameExistsValidationError('exists', 2500);
    });

    await expect(ensureFolderPath(client as any, '/LFS')).resolves.toBe('root/LFS-by-other');
  });

  it('rethrows the conflict when the re-listed name is not a folder', async () => {
    const tree: Record<string, FakeNode[]> = { root: [] };
    const client = makeClient(tree);
    const conflict = new NodeWithSameNameExistsValidationError('exists', 2500, 'root/draft', true);
    client.createFolder.mockImplementationOnce(async () => {
      tree.root.push({ uid: 'root/draft', name: 'LFS', type: NodeType.File });
      throw conflict;
    });

    await expect(ensureFolderPath(client as any, '/LFS')).rejects.toBe(conflict);
  });

  it('rethrows other SDK failures unchanged', async () => {
    const client = makeClient({ root: [] });
    const failure = new Error('network down');
    client.createFolder.mockRejectedValueOnce(failure);
    await expect(ensureFolderPath(client as any, '/LFS')).rejects.toBe(failure);
  });
});

describe('findFileNodeInFolder', () => {
  const oid = 'a'.repeat(64);
  const client = makeClient({
    folder: [
      { uid: 'folder/sub', name: oid, type: NodeType.Folder },
      { uid: 'folder/file', name: oid, type: NodeType.File, activeRevision: { uid: 'rev-7' } },
    ],
  });

  it('returns the file node (not a folder of the same name) with its active revision', async () => {
    await expect(findFileNodeInFolder(client as any, 'folder', oid)).resolves.toMatchObject({ uid: 'folder/file', activeRevision: { uid: 'rev-7' } });
    await expect(findFileInFolder(client as any, 'folder', oid)).resolves.toBe('folder/file');
  });

  it('returns null when the name is absent', async () => {
    await expect(findFileNodeInFolder(client as any, 'folder', 'b'.repeat(64))).resolves.toBeNull();
    await expect(findFileInFolder(client as any, 'folder', 'b'.repeat(64))).resolves.toBeNull();
  });
});
