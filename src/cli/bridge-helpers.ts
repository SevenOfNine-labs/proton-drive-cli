/**
 * Helper functions for Git LFS bridge operations
 * Handles OID-based path mapping and folder structure for Git LFS objects
 *
 * Uses ProtonDriveClient (official SDK) for all Drive operations.
 */

import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { NodeType } from '@protontech/drive-sdk';
import { PathNotFoundError } from '../errors/types';
import { logger } from '../utils/logger';
import { resolvePathToNodeUid, findFileInFolder } from '../sdk/pathResolver';
import { describeNodeErrors, getNodeName } from '../sdk/nodeEntity';

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
 * Where an OID lives in Proton Drive: its full path, the folder holding it
 * and its file name (the lowercase OID).
 */
export interface OidFileLocation {
  fullPath: string;
  folderPath: string;
  fileName: string;
}

export function oidFileLocation(storageBase: string, oid: string): OidFileLocation {
  const fullPath = oidToPath(storageBase, oid);
  const pathParts = fullPath.split('/').filter((p) => p.length > 0);
  return {
    fullPath,
    folderPath: '/' + pathParts.slice(0, -1).join('/'),
    fileName: pathParts[pathParts.length - 1],
  };
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
  const { fullPath, folderPath, fileName } = oidFileLocation(storageBase, oid);

  try {
    const folderUid = await resolvePathToNodeUid(client, folderPath);
    const fileUid = await findFileInFolder(client, folderUid, fileName);
    if (fileUid) {
      logger.debug(`Found file by OID: ${fullPath}`);
    } else {
      logger.debug(`File not found by OID: ${fullPath}`);
    }
    return fileUid;
  } catch (error) {
    if (error instanceof PathNotFoundError) {
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
 * @throws PathNotFoundError when the folder does not exist
 */
export async function listFolder(
  client: ProtonDriveClient,
  folderPath: string,
): Promise<ListItem[]> {
  const folderUid = await resolvePathToNodeUid(client, folderPath);
  const items: ListItem[] = [];

  for await (const child of client.iterateFolderChildren(folderUid)) {
    const nodeType = child.type;
    if (!KNOWN_NODE_TYPES.has(nodeType)) {
      logger.debug(`Skipping unknown node type "${nodeType}": ${getNodeName(child) ?? child.uid}`);
      continue;
    }
    const name = getNodeName(child);
    if (!name) {
      logger.debug(`Skipping degraded node: ${describeNodeErrors(child)}`);
      continue;
    }
    items.push({
      name,
      type: nodeType === NodeType.File ? 'file' : 'folder',
      size: child.totalStorageSize || 0,
      modifiedTime: child.modificationTime
        ? Math.floor(child.modificationTime.getTime() / 1000)
        : 0,
    });
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
