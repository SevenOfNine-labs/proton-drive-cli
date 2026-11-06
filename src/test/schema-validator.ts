/**
 * JSON Schema (draft 2020-12) validator over every schema shipped in
 * schemas/, for tests that check real command output against the published
 * contract. Ajv runs in strict mode so a malformed schema fails the suite.
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export const SCHEMAS_DIR = path.resolve(__dirname, '..', '..', 'schemas');
export const SCHEMA_ID_BASE = 'https://sevenofnine-labs.github.io/proton-drive-cli/schemas';

export interface SchemaFile {
  /** Path relative to schemas/, e.g. "bridge/v1/request.schema.json" */
  relativePath: string;
  absolutePath: string;
  document: Record<string, unknown>;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

export function readJsonFile(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, relativePath), 'utf8'));
}

/** Every *.json under schemas/, schemas and data files alike. */
export function listSchemaDirFiles(): SchemaFile[] {
  return walk(SCHEMAS_DIR, [])
    .sort()
    .map((absolutePath) => ({
      relativePath: path.relative(SCHEMAS_DIR, absolutePath).split(path.sep).join('/'),
      absolutePath,
      document: JSON.parse(fs.readFileSync(absolutePath, 'utf8')),
    }));
}

/** Files that are JSON Schemas (declare `$schema`). */
export function listSchemaFiles(): SchemaFile[] {
  return listSchemaDirFiles().filter((file) => typeof file.document.$schema === 'string');
}

/** Files that are data documents described by a sibling *.schema.json. */
export function listDataFiles(): SchemaFile[] {
  return listSchemaDirFiles().filter((file) => typeof file.document.$schema !== 'string');
}

export function schemaIdFor(relativePath: string): string {
  return `${SCHEMA_ID_BASE}/${relativePath}`;
}

let cachedAjv: Ajv2020 | undefined;

export function createSchemaValidator(): Ajv2020 {
  if (cachedAjv) return cachedAjv;
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: true,
    strictTuples: true,
    strictRequired: true,
    allErrors: true,
    allowUnionTypes: false,
  });
  addFormats(ajv);
  for (const file of listSchemaFiles()) {
    ajv.addSchema(file.document, schemaIdFor(file.relativePath));
  }
  cachedAjv = ajv;
  return ajv;
}

export function compileSchema(relativePath: string): ValidateFunction {
  const validate = createSchemaValidator().getSchema(schemaIdFor(relativePath));
  if (!validate) {
    throw new Error(`Schema not registered: ${relativePath}`);
  }
  return validate;
}

export function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`).join('; ');
}

/**
 * Validate a document exactly as it would be serialized (undefined-valued
 * properties dropped) against a schema file under schemas/.
 * @throws Error listing every violation
 */
export function assertValidAgainstSchema(relativePath: string, document: unknown): void {
  const serialized = JSON.parse(JSON.stringify(document));
  const validate = compileSchema(relativePath);
  if (!validate(serialized)) {
    throw new Error(`${relativePath} rejected document ${JSON.stringify(serialized)}: ${formatErrors(validate.errors)}`);
  }
}
