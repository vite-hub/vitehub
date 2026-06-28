# Controlled Curl Uses Source Network Grants

Superseded note: ADR 0075 retracts Capability instruction slots and `workspace.sources` placement. Source Network Grants remain current, but model-facing guidance must come from tool contracts or explicit Agent Driver Instructions.

When `workspaceShell()` is enabled, visible API-backed Sources may contribute **Source Network Grants** that let the Shell Runtime run controlled `curl` commands against the Source's declared request boundary. The model uses normal `curl` syntax, while the Execution Provider validates the resulting HTTP request against the Source Request Shape, injected Source Request Credentials, and Selected Workspace Scope. The generated **Source Request Descriptor** gives the model compact request guidance, but authority comes from the grant, not from Source Instructions.

Model-facing descriptor guidance should not be emitted through ambient instruction templating. `workspaceShell()` can expose structured tool contracts and DevTools metadata when visible Source Request Descriptors exist.

Source Request Shapes use Standard Schema-compatible validators for enforcement. When a Source Request Shape is exposed through a Source Request Descriptor, its model-authored query and body inputs also need a Standard JSON Schema-compatible projection so the model can inspect the shape without ViteHub inventing a parallel schema language.

For each request part, `fetch()` chooses either a concrete Fetch-style value (`query`, `body`) or a schema-backed model input (`querySchema`, `bodySchema`). These branches are mutually exclusive so a Source does not carry two competing default inputs for the same request part. Schema-backed branches may still provide defaults through validation. If a Source-Backed Path is present, schema-backed request parts produce the default read by validating empty input; when that cannot produce a valid request, the Source read fails clearly and the declaration should either add schema defaults or become request-only.

The v1 method set is `GET`, `HEAD`, and `POST`. `GET` and `HEAD` may use query branches but not body branches. `POST` may use both query and body branches.

## Considered Options

- A separate HTTP Capability for controlled `curl` was rejected because the useful boundary is already Source-owned and scope-owned.
- OpenAPI as the first public Source request language was rejected because the v1 need is a smaller Source Request Shape, not a full API catalog contract.
- A single generated request index was rejected because per-source descriptors keep the Source boundary obvious and let agents inspect `.vitehub/sources/<sourceKey>.json` directly.
- Workspace-level curl parsing was rejected because ADR 0043 keeps utility semantics inside Execution Providers; Command Analysis may route or flag, but must not own curl request semantics.
- Custom curl-like syntax was rejected because agents should use the real command syntax they already know.
- A ViteHub-specific schema summary was rejected because the Standard Schema family already includes a Standard JSON Schema-compatible projection interface for this purpose.
- Allowing both `body` and `bodySchema` for the same Source was rejected because it creates two possible defaults; the same rule applies to `query` and `querySchema`.
- A separate `defaultBody` or `defaultQuery` beside schema-backed request parts was rejected because schema validation is already the defaulting boundary.
- Supporting write-semantics methods such as `PUT`, `PATCH`, and `DELETE` was rejected for v1 because request-shaped Sources are read boundaries; those methods belong to Capabilities or a future effect boundary.
- Automatic Workspace materialization of curl output was rejected because request output should remain an ephemeral Shell Observation unless an explicit Workspace policy chooses to persist it.
- A new Workspace template slot for controlled `curl` descriptors was rejected because generated request descriptors should not create another instruction surface.

## Consequences

The Just Bash and Cloudflare providers own controlled network command behavior. They may support pipes and normal curl body flags, but the final HTTP request must match the Source Network Grant and Source Request Shape. API-backed Sources without a default Source-Backed Path can still be useful as Request-Only Sources when they have a Source Request Descriptor.

A shell tool description may still carry a short derived pointer, but it must be generated from the same visible descriptor set and not become a second template or schema surface.
