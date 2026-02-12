/**
 * Helper functions for Git LFS bridge operations
 * Handles OID-based path mapping and folder structure for Git LFS objects
 *
 * Uses ProtonDriveClient (official SDK) for all Drive operations.
 */

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { NodeType } from '@protontech/drive-sdk';
import { logger } from '../utils/logger';
import { resolvePathToNodeUid, ensureFolderPath, findFileInFolder } from '../sdk/pathResolver';

/** Node types we recognize. SDK 0.9.8+ added album/photo — skip them. */
const KNOWN_NODE_TYPES = new Set<string>([NodeType.File, NodeType.Folder]);

// Re-export canonical oidToPath/pathToOid from bridge/validators (no heavy deps)
export { oidToPath, pathToOid } from '../bridge/validators';
import { oidToPath } from '../bridge/validators';

/**
 * Listing result item
 */
export interface ListItem {
  name: string;
  type: 'file' | 'folder';
  size: number;
  modifiedTime: number;
}

/**
 * Ensure OID prefix folder exists in Proton Drive
 * Creates the 2-character prefix directory if it doesn't exist
 *
 * @param client - Initialized ProtonDriveClient
 * @param parentPath - Parent directory path (e.g., "/LFS")
 * @param prefix - 2-character prefix (e.g., "ab")
 * @returns UID of the prefix folder
 */
export async function ensureOidFolder(
  client: ProtonDriveClient,
  parentPath: string,
  prefix: string,
): Promise<string> {
  if (prefix.length !== 2) {
    throw new Error(`Invalid prefix: must be 2 characters, got: ${prefix}`);
  }

  const folderPath = `${parentPath}/${prefix}`;
  return ensureFolderPath(client, folderPath);
}

/**
 * Find file by OID in Proton Drive
 * Resolves OID to the folder path and searches for the file by name
 *
 * @param client - Initialized ProtonDriveClient
 * @param storageBase - Base directory (e.g., "LFS")
 * @param oid - Git LFS object ID
 * @returns Node UID if file exists, null if not found
 */
export async function findFileByOid(
  client: ProtonDriveClient,
  storageBase: string,
  oid: string,
): Promise<string | null> {
  const fullPath = oidToPath(storageBase, oid);
  const pathParts = fullPath.split('/').filter((p) => p.length > 0);
  const fileName = pathParts[pathParts.length - 1]; // The OID filename
  const folderPath = '/' + pathParts.slice(0, -1).join('/'); // /base/prefix/second

  try {
    const folderUid = await resolvePathToNodeUid(client, folderPath);
    const fileUid = await findFileInFolder(client, folderUid, fileName);
    if (fileUid) {
      logger.debug(`Found file by OID: ${fullPath}`);
    } else {
      logger.debug(`File not found by OID: ${fullPath}`);
    }
    return fileUid;
  } catch (error: any) {
    if (error?.message?.includes('Not found')) {
      logger.debug(`Prefix folder not found for OID: ${fullPath}`);
      return null;
    }
    throw error;
  }
}

/**
 * List folder contents using ProtonDriveClient
 *
 * @param client - Initialized ProtonDriveClient
 * @param folderPath - Path to list (e.g., "/LFS")
 * @returns Array of ListItem
 */
export async function listFolder(
  client: ProtonDriveClient,
  folderPath: string,
): Promise<ListItem[]> {
  const folderUid = await resolvePathToNodeUid(client, folderPath);
  const items: ListItem[] = [];

  for await (const child of client.iterateFolderChildren(folderUid)) {
    if (child.ok) {
      const nodeType = child.value.type;
      if (!KNOWN_NODE_TYPES.has(nodeType)) {
        logger.debug(`Skipping unknown node type "${nodeType}": ${child.value.name}`);
        continue;
      }
      items.push({
        name: child.value.name,
        type: nodeType === NodeType.File ? 'file' : 'folder',
        size: child.value.totalStorageSize || 0,
        modifiedTime: child.value.modificationTime
          ? Math.floor(child.value.modificationTime.getTime() / 1000)
          : 0,
      });
    } else {
      logger.debug(`Skipping degraded node: ${JSON.stringify(child.error)}`);
    }
  }

  return items;
}

/**
 * Delete a file by OID from Proton Drive.
 * Trashes the node first, then permanently deletes it.
 *
 * @param client - Initialized ProtonDriveClient
 * @param storageBase - Base directory (e.g., "LFS")
 * @param oid - Git LFS object ID
 * @returns true if deleted, false if not found
 */
export async function deleteByOid(
  client: ProtonDriveClient,
  storageBase: string,
  oid: string,
): Promise<boolean> {
  const nodeUid = await findFileByOid(client, storageBase, oid);
  if (!nodeUid) {
    return false;
  }

  // Trash first (required before permanent delete)
  for await (const result of client.trashNodes([nodeUid])) {
    if (!result.ok) {
      throw new Error(`Failed to trash OID ${oid}: ${JSON.stringify(result.error)}`);
    }
  }

  // Permanently delete
  for await (const result of client.deleteNodes([nodeUid])) {
    if (!result.ok) {
      throw new Error(`Failed to delete OID ${oid}: ${JSON.stringify(result.error)}`);
    }
  }

  logger.debug(`Deleted file by OID: ${oid}`);
  return true;
}

/**
 * List all OIDs in a specific prefix folder or all prefix folders
 *
 * @param client - Initialized ProtonDriveClient
 * @param storageBase - Base directory (e.g., "LFS")
 * @param prefix - 2-character prefix (e.g., "ab") or null for all
 * @returns Array of OIDs
 */
export async function listOids(
  client: ProtonDriveClient,
  storageBase: string,
  prefix: string | null = null,
): Promise<string[]> {
  const normalizedBase = storageBase.replace(/^\/+|\/+$/g, '');
  const basePath = `/${normalizedBase}`;

  if (prefix) {
    if (prefix.length !== 2) {
      throw new Error(`Invalid prefix: must be 2 characters, got: ${prefix}`);
    }

    const prefixPath = `${basePath}/${prefix}`;
    const oids: string[] = [];
    try {
      const secondFolders = await listFolder(client, prefixPath);
      for (const secondFolder of secondFolders) {
        if (secondFolder.type !== 'folder' || secondFolder.name.length !== 2) {
          continue;
        }
        const secondPath = `${prefixPath}/${secondFolder.name}`;
        const items = await listFolder(client, secondPath);
        for (const item of items) {
          if (item.type === 'file') {
            oids.push(item.name.toLowerCase());
          }
        }
      }
      return oids;
    } catch (error: any) {
      if (error?.message?.includes('Not found') || error?.message?.includes('not found')) {
        return [];
      }
      throw error;
    }
  }

  // List all prefix folders → second-level folders → files
  const allOids: string[] = [];
  try {
    const prefixFolders = await listFolder(client, basePath);

    for (const folder of prefixFolders) {
      if (folder.type !== 'folder' || folder.name.length !== 2) {
        continue;
      }

      const prefixPath = `${basePath}/${folder.name}`;
      const secondFolders = await listFolder(client, prefixPath);

      for (const secondFolder of secondFolders) {
        if (secondFolder.type !== 'folder' || secondFolder.name.length !== 2) {
          continue;
        }

        const secondPath = `${prefixPath}/${secondFolder.name}`;
        const items = await listFolder(client, secondPath);

        for (const item of items) {
          if (item.type === 'file') {
            allOids.push(item.name.toLowerCase());
          }
        }
      }
    }
  } catch (error: any) {
    if (error?.message?.includes('Not found') || error?.message?.includes('not found')) {
      return [];
    }
    throw error;
  }

  return allOids;
}
