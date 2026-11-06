/** Resolves Drive paths such as "/LFS/ab/c1/<oid>" to SDK node UIDs through iterateFolderChildren. */

import type { NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';
import { NodeType, NodeWithSameNameExistsValidationError } from '@protontech/drive-sdk';
import { AppError, ErrorCode, PathNotFoundError } from '../errors/types';
import { logger } from '../utils/logger';
import { getNodeName } from './nodeEntity';

function splitPath(path: string): string[] {
  if (path.includes('\0')) {
    throw new AppError('Null byte in path', ErrorCode.INVALID_PATH, { path }, false);
  }
  if (path.split(/[/\\]/).includes('..')) {
    throw new AppError('Path traversal not allowed', ErrorCode.INVALID_PATH, { path }, false);
  }
  return path.split('/').filter((part) => part.length > 0);
}

/**
 * Find a direct child of a folder by its decrypted name.
 *
 * @returns The child node, or null when no child carries that name
 */
export async function findChildByName(
  client: ProtonDriveClient,
  parentUid: string,
  name: string,
): Promise<NodeEntity | null> {
  for await (const child of client.iterateFolderChildren(parentUid)) {
    if (getNodeName(child) === name) {
      return child;
    }
  }
  return null;
}

/**
 * Resolve a path string to a node UID by traversing the folder tree.
 *
 * @param client - Initialized ProtonDriveClient
 * @param path - Path like "/LFS/ab/c1" (leading/trailing slashes ignored)
 * @returns Node UID of the resolved path
 * @throws PathNotFoundError if any path component is not found
 */
export async function resolvePathToNodeUid(
  client: ProtonDriveClient,
  path: string,
): Promise<string> {
  const parts = splitPath(path);

  const root = await client.getMyFilesRootFolder();
  let currentUid = root.uid;

  for (const part of parts) {
    const child = await findChildByName(client, currentUid, part);
    if (!child) {
      throw new PathNotFoundError(path, part);
    }
    currentUid = child.uid;
  }

  return currentUid;
}

/**
 * Create a folder, accepting a concurrent creation of the same name: the SDK's
 * NodeWithSameNameExistsValidationError carries the winner's `existingNodeUid`, else the folder is listed again.
 */
async function createFolderOrReuse(
  client: ProtonDriveClient,
  parentUid: string,
  name: string,
): Promise<string> {
  try {
    logger.debug(`Creating folder: ${name}`);
    const created = await client.createFolder(parentUid, name);
    return created.uid;
  } catch (error) {
    if (!(error instanceof NodeWithSameNameExistsValidationError)) {
      throw error;
    }
    if (error.existingNodeUid && !error.isUnfinishedUpload) {
      logger.debug(`Folder ${name} was created concurrently; using ${error.existingNodeUid}`);
      return error.existingNodeUid;
    }
    const existing = await findChildByName(client, parentUid, name);
    if (!existing || existing.type !== NodeType.Folder) {
      throw error;
    }
    logger.debug(`Folder ${name} was created concurrently; resolved ${existing.uid} by listing`);
    return existing.uid;
  }
}

/**
 * Resolve a path string, creating missing folders along the way.
 *
 * @param client - Initialized ProtonDriveClient
 * @param path - Path like "/LFS/ab/c1"
 * @returns Node UID of the final folder
 */
export async function ensureFolderPath(
  client: ProtonDriveClient,
  path: string,
): Promise<string> {
  const parts = splitPath(path);

  const root = await client.getMyFilesRootFolder();
  let currentUid = root.uid;

  for (const part of parts) {
    const child = await findChildByName(client, currentUid, part);
    currentUid = child ? child.uid : await createFolderOrReuse(client, currentUid, part);
  }

  return currentUid;
}

/**
 * Find a file node by name in a folder identified by UID.
 *
 * @returns The file node (uid, activeRevision, ...), or null if not found
 */
export async function findFileNodeInFolder(
  client: ProtonDriveClient,
  folderUid: string,
  fileName: string,
): Promise<NodeEntity | null> {
  for await (const child of client.iterateFolderChildren(folderUid)) {
    if (getNodeName(child) === fileName && child.type === NodeType.File) {
      return child;
    }
  }
  return null;
}

/**
 * Find a file by name in a folder identified by UID.
 *
 * @returns Node UID of the file, or null if not found
 */
export async function findFileInFolder(
  client: ProtonDriveClient,
  folderUid: string,
  fileName: string,
): Promise<string | null> {
  const node = await findFileNodeInFolder(client, folderUid, fileName);
  return node ? node.uid : null;
}
