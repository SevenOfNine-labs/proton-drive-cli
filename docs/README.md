# Documentation

Project-owned docs live here. The vendored SDK docs remain under `submodules/sdk/` and are referenced, not duplicated.

## Start Here

1. [Architecture Overview](architecture/overview.md)
2. [Browser Fork Authentication](architecture/browser-fork-auth.md)
3. [Bridge Protocol Reference](reference/bridge-protocol.md)
4. [Configuration](operations/configuration.md)

## Pages

### Architecture

- [Overview](architecture/overview.md): components, auth model, Git LFS integration.
- [Architecture](architecture/ARCHITECTURE.md): where runtime truth and contract tests live.
- [Browser Fork Authentication](architecture/browser-fork-auth.md): the only account login path.
- [Feature Audit](architecture/feature-audit.md): maturity of each surface.

### Operations

- [Configuration](operations/configuration.md): state files, environment variables, command options, build.

### Reference

- [Bridge Protocol](reference/bridge-protocol.md): `bridge <command>` invocation, request fields, envelope, payloads, error codes.
- [Doctor](reference/doctor.md): offline preflight checks, report fields, exit status.
- JSON Schemas: `schemas/bridge/v1/` and `schemas/doctor/v1/` in this repository, published at `https://sevenofnine-labs.github.io/proton-drive-cli/schemas/`.

### Security

- [Credential Security](security/credentials.md)

### Contributing

- [Documentation Guide](DOCUMENTATION_GUIDE.md): what to document and what never to document.
- TypeScript API reference: `yarn docs` (TypeDoc, published under `typescript/` on the docs site).

## Structure

- `docs/architecture/`: component boundaries, data flow, SDK adapter layer.
- `docs/operations/`: runtime configuration, session management.
- `docs/reference/`: contracts derived from code and schemas.
- `docs/security/`: credential flows, trust boundaries, threat mitigations.

## Canonical Rule

When docs disagree, runtime behavior and tests win. Update docs in the same change.
