import type { InvalidNameError, NodeEntity, Result } from '@protontech/drive-sdk';

export function resultValue<T>(result: Result<T, unknown>): T | null {
  return result.ok ? result.value : null;
}

export function getNodeName(node: NodeEntity): string | null {
  return resultValue(node.name);
}

export function getNodeDisplayName(node: NodeEntity): string {
  if (node.name.ok) {
    return node.name.value;
  }

  const error = node.name.error as InvalidNameError | Error | undefined;
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }

  return '<decryption failed>';
}

export function describeNodeErrors(node: NodeEntity): string {
  if (node.errors && node.errors.length > 0) {
    return JSON.stringify(node.errors);
  }
  if (!node.name.ok) {
    return JSON.stringify(node.name.error);
  }
  return 'unknown node degradation';
}
