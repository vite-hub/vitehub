# Request-Only API-Backed Sources

API-backed Sources may be **Request-Only Sources** when a useful default Source-Backed Path would be misleading or arbitrary. This revises ADR 0018's requirement that every API-backed Source map to a stable read target: a Request-Only Source is valid when it exposes a scoped **Source Request Descriptor** and **Source Network Grant**, while controlled shell requests return ephemeral Shell observations and materialization remains an explicit Workspace policy decision.

## Considered Options

- Requiring a default Source-Backed Path for every `fetch()` was rejected because filtered runtime APIs often need page, user, or invocation input before a response is meaningful.
- Treating this as only a model-facing HTTP Capability was rejected because the allowed request boundary should remain tied to the Workspace Source, Workspace Scope, Source Request Descriptor, and Shell Network Grant.

## Consequences

Request-Only Sources do not create default workspace data files. They are visible through generated Workspace metadata and controlled shell access when the Selected Workspace Scope allows the Source. Arbitrary model-facing query tools still belong to Capabilities; Request-Only Sources are valid only because ViteHub owns the request shape, credentials, scope, and Shell Runtime boundary.
