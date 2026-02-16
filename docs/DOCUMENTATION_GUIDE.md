# Documentation Guide

## Overview

This project uses **TypeDoc** with **TSDoc** comments to generate API documentation, similar to Doxygen for C++.

## Quick Start

```bash

# Generate documentation

yarn docs

# Generate and watch for changes

yarn docs:watch

# Serve documentation locally

yarn docs:serve

# Open http://localhost:8080

```

## TSDoc Comment Syntax

### Basic Function Documentation

```typescript
/**

 * Brief description of the function (one line).

 *

 * Detailed description of what the function does, how it works,
 * and any important implementation details.

 *

 * @param paramName - Description of the parameter
 * @param anotherParam - Description with more details
 * @returns Description of the return value
 * @throws {ErrorType} Description of when this error is thrown

 *

 * @example
 * ```typescript
 * const result = myFunction('value', 42);
 * console.log(result); // Output: processed value
 * ```

 *

 * @see {@link RelatedFunction} for related functionality
 * @since 0.1.0

 */
export function myFunction(paramName: string, anotherParam: number): string {
  return `processed ${paramName}`;
}

```

### Class Documentation

```typescript
/**

 * Brief description of the class.

 *

 * Detailed description of the class's purpose and usage.

 *

 * @example
 * ```typescript
 * const instance = new MyClass('config');
 * await instance.doSomething();
 * ```

 */
export class MyClass {
  /**

   * Class property description.

   */
  private config: string;

  /**

   * Constructor description.

   *

   * @param config - Configuration string

   */
  constructor(config: string) {
    this.config = config;
  }

  /**

   * Method description.

   *

   * @param input - Input parameter
   * @returns Processed result

   */
  public doSomething(input: string): Promise<string> {
    return Promise.resolve(`${this.config}: ${input}`);
  }
}

```

### CLI Command Documentation

```typescript
/**

 * Upload a file to Proton Drive.

 *

 * This command uploads a local file to a remote path in Proton Drive with
 * end-to-end encryption. The file is encrypted locally before being sent
 * to the server.

 *

 * @param localPath - Local file path to upload
 * @param remotePath - Remote destination path in Proton Drive
 * @param options - Upload options
 * @param options.overwrite - Overwrite existing file if true
 * @param options.credentialProvider - Credential provider to use (default: pass-cli)

 *

 * @returns Promise resolving to upload result
 * @throws {FileNotFoundError} If local file doesn't exist
 * @throws {PermissionDeniedError} If user lacks permission for destination
 * @throws {RateLimitError} If Proton API rate limit is exceeded

 *

 * @example
 * ```bash
 * # CLI usage
 * proton-drive upload ./file.pdf /Documents/file.pdf
 * ```

 *

 * @example
 * ```typescript
 * // Programmatic usage
 * await uploadCommand('./file.pdf', '/Documents/file.pdf', {
 *   overwrite: true,
 *   credentialProvider: 'pass-cli'
 * });
 * ```

 *

 * @category CLI Commands
 * @see {@link downloadCommand} for downloading files
 * @since 0.1.0

 */
export async function uploadCommand(
  localPath: string,
  remotePath: string,
  options?: UploadOptions
): Promise<UploadResult> {
  // Implementation
}

```

## TSDoc Tags Reference

### Required Tags

| Tag | Description | Example |
| ----- | ------------- | --------- |
| `@param` | Parameter description | `@param username - User's email` |
| `@returns` | Return value description | `@returns Session credentials` |

### Optional but Recommended Tags

| Tag | Description | Example |
| ----- | ------------- | --------- |
| `@throws` | Exceptions thrown | `@throws {RateLimitError} When rate limited` |
| `@example` | Usage example | See examples above |
| `@category` | Group by category | `@category CLI Commands` |
| `@see` | Related items | `@see {@link login} for authentication` |
| `@since` | Version added | `@since 0.1.0` |
| `@deprecated` | Mark as deprecated | `@deprecated Use newFunction instead` |

### Advanced Tags

| Tag | Description | Example |
| ----- | ------------- | --------- |
| `@internal` | Hide from public docs | `@internal` |
| `@alpha` | Experimental API | `@alpha` |
| `@beta` | Beta API | `@beta` |
| `@remarks` | Additional remarks | `@remarks This is cached` |
| `@defaultValue` | Default param value | `@defaultValue 'pass-cli'` |

## Categorization

Use `@category` to group related functions:

```typescript
/**

 * Login to Proton Drive.

 *

 * @category CLI Commands

 */
export function loginCommand() { }

/**

 * Retry with exponential backoff.

 *

 * @category Utilities

 */
export function retryWithBackoff() { }

/**

 * Categorize an error.

 *

 * @category Error Handling

 */
export function categorizeError() { }

```

## Priority Documentation Targets

### 1. CLI Commands (Highest Priority)

All commands in `src/cli/*.ts`:

- `login`
- `logout`
- `upload`
- `download`
- `ls`
- `mkdir`
- `mv`
- `rm`
- `cat`
- `info`
- `bridge` commands

### 2. Public API Functions

Main entry points:

- `src/auth/index.ts` - `AuthService` class and methods
- `src/drive/operations.ts` - All drive operations
- `src/bridge/index.ts` - Bridge protocol handlers

### 3. Utility Functions

Core utilities:

- `src/utils/retry.ts` - `retryWithBackoff()`
- `src/utils/circuit-breaker.ts` - `CircuitBreaker` class
- `src/errors/types.ts` - Error classes and `categorizeError()`

### 4. Configuration

- `src/config/timeouts.ts` - All timeout functions

## Documentation Quality Checklist

For each function, ensure:

- [ ] One-line summary (first line of doc comment)
- [ ] Detailed description (what it does, how it works)
- [ ] All `@param` tags with clear descriptions
- [ ] `@returns` tag with clear description
- [ ] `@throws` tags for all possible exceptions
- [ ] At least one `@example` (preferably CLI and code examples)
- [ ] `@category` tag for grouping
- [ ] `@see` tags for related functions
- [ ] `@since` version tag

## Integration with Deployment

### GitHub Pages

Add to `.github/workflows/docs.yml`:

```yaml
name: Documentation

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:

      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4

        with:
          node-version: '25'
          cache: 'yarn'

      - run: yarn install --immutable
      - run: yarn docs
      - uses: actions/upload-pages-artifact@v3

        with:
          path: docs/api

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:

      - uses: actions/deploy-pages@v4

        id: deployment

```

### Access Documentation

After deployment:

- **GitHub Pages**: `https://<username>.github.io/<repo>/`
- **Local**: `yarn docs:serve` → `http://localhost:8080`

## Best Practices

### 1. Write Documentation First

```typescript
// ✅ Good: Write docs before implementation
/**

 * Upload file with retry logic.
 * @param path - File path
 * @returns Upload result

 */
export async function upload(path: string): Promise<Result> {
  // TODO: Implement
}

```

### 2. Use Code Examples

```typescript
/**

 * @example
 * ```typescript
 * const result = await retry(() => upload('/file.txt'));
 * ```

 */

```

### 3. Document Edge Cases

```typescript
/**

 * @remarks
 * - Returns cached value if file unchanged (mtime:size match)
 * - Throws if file doesn't exist
 * - Automatically retries on network errors (max 3 attempts)

 */

```

### 4. Link Related Functions

```typescript
/**

 * @see {@link retryWithBackoff} for retry logic
 * @see {@link categorizeError} for error handling

 */

```

### 5. Maintain Consistency

- Use present tense: "Uploads file" not "Upload file"
- Use active voice: "Validates input" not "Input is validated"
- Be concise but complete
- Include units: "Timeout in milliseconds" not "Timeout"

## Common Patterns

### Async Function

```typescript
/**

 * Authenticates user with SRP protocol.

 *

 * @param username - User's email address
 * @param password - User's password (never stored)
 * @returns Promise resolving to session credentials
 * @throws {AuthenticationError} If credentials are invalid
 * @throws {RateLimitError} If too many login attempts

 */
export async function login(
  username: string,
  password: string
): Promise<SessionCredentials> {
  // Implementation
}

```

### Error Handler

```typescript
/**

 * Categorizes an error for consistent error handling.

 *

 * Analyzes error type, HTTP status, and Proton error codes to determine:
 * - Error category (network, auth, rate-limit, etc.)
 * - Whether error is retryable
 * - User-friendly error message
 * - Recovery suggestions

 *

 * @param error - Error to categorize (any type)
 * @returns Categorized error with metadata

 *

 * @example
 * ```typescript
 * try {
 *   await apiCall();
 * } catch (error) {
 *   const categorized = categorizeError(error);
 *   if (categorized.retryable) {
 *     // Retry logic
 *   } else {
 *     console.error(categorized.userMessage);
 *   }
 * }
 * ```

 *

 * @category Error Handling

 */
export function categorizeError(error: any): CategorizedError {
  // Implementation
}

```

### Configuration

```typescript
/**

 * Loads timeout configuration from environment variables.

 *

 * Environment variables:
 * - `PROTON_DRIVE_AUTH_TIMEOUT_MS`: Auth timeout (default: 30000)
 * - `PROTON_DRIVE_UPLOAD_TIMEOUT_MS`: Upload timeout (default: 300000)
 * - `PROTON_DRIVE_DOWNLOAD_TIMEOUT_MS`: Download timeout (default: 300000)

 *

 * Values are validated and capped at 10 minutes maximum.

 *

 * @returns Timeout configuration object

 *

 * @example
 * ```typescript
 * const config = loadTimeoutConfig();
 * console.log(config.authMs); // 30000 (default)
 * ```

 *

 * @category Configuration

 */
export function loadTimeoutConfig(): TimeoutConfig {
  // Implementation
}

```

## References

- [TSDoc Specification](https://tsdoc.org/)
- [TypeDoc Documentation](https://typedoc.org/)
- [TypeDoc Tags](https://typedoc.org/guides/tags/)
