# Documentation

Project-owned docs live here. The vendored SDK docs remain under `submodules/sdk/` and are referenced, not duplicated.

## Start Here

1. [Architecture Overview](architecture/overview.md)
2. [Formal Feature Audit](architecture/feature-audit.md)
3. [Credential Security](security/credentials.md)
4. [Configuration](operations/configuration.md)

## Structure

- `docs/architecture/`: component boundaries, data flow, SDK adapter layer.
- `docs/security/`: credential flows, trust boundaries, threat mitigations.
- `docs/operations/`: runtime configuration, session management.

## Canonical Rule

When docs disagree, runtime behavior and tests win. Update docs in the same change.
