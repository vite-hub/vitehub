# HTTP Request Core for Sources and Capabilities

Updated by [ADR 0058: Request-Only API-Backed Sources](./0058-request-only-api-backed-sources.md), [ADR 0059: Source Fetch Validates Requests, Not Responses](./0059-source-fetch-validates-requests-not-responses.md), [ADR 0060: Controlled Curl Uses Source Network Grants](./0060-controlled-curl-uses-source-network-grants.md), and [ADR 0061: Source Fetch Request Factory Receives Execution Context](./0061-source-fetch-request-factory-receives-execution-context.md): `fetch()` may be request-only, validates request inputs rather than response bodies, exposes controlled shell descriptors through Source Network Grants, and lets request factories receive a narrow execution context for credentials and signing while keeping the Source definition static.

API-backed Workspace Sources and API Capabilities share a neutral HTTP Request Definition core, but remain separate public projections. The core owns request execution concerns such as method, URL, query, headers, body, timeout, abort, retry, response decoding, redaction, and hooks; Sources add read-only addressable Workspace item semantics, while Capabilities add model-facing tool semantics and query/effect policy.

## Considered Options

- Treating `fetch` as the Source abstraction was rejected because a Workspace Source must expose a stable read-only address space, not arbitrary HTTP calls.
- Treating API calls only as Capabilities was rejected because read-only API data can be useful Workspace evidence outside Agents when it maps to Source-Backed Paths.
- Sharing one undifferentiated API abstraction across Sources and Capabilities was rejected because Source reads and model-facing tools have different identity, cache, materialization, schema export, and side-effect rules.
- Requiring JSON Schema at definition time was rejected because ViteHub should accept Standard Schema-compatible validators as the TypeScript authoring surface and only require JSON Schema conversion when an adapter or export target needs it.

## Consequences

An API-backed Source is valid only when it exposes stable read targets that can map to Source item keys and Source-Backed Paths. Query-only, aggregate-only, arbitrary-parameter, and side-effectful API calls remain Capability tools even when they share the same HTTP Request Definition core.

The first Agent Capability projection should be `fetch()` from `@vite-hub/agent/capabilities`. It exposes query-only model-facing fetch tools for JSON and text resources. Effect/mutation tools, approval policy, retry/idempotency behavior, binary/image outputs, and richer model-facing descriptions need their own design pass.

The first API-backed Source helper should be `fetch(...)` for one declared HTTP read target and one Source-Backed Path, with the path derived from the URL when safe and overridable when needed. Multiple static HTTP items should be represented as multiple Source Map entries rather than a nested item map. Shared origin/client configuration and enumerable API collections are deferred until a real many-item Source design is needed.

Default Source-Backed Path derivation should parse URLs with the platform `URL` class, use the URL pathname, ignore protocol, host, credentials, hash, and query parameters, and require an explicit path when query parameters materially distinguish the resource. Query parameters should not be encoded into default paths because they create unstable names and may leak sensitive data.

`fetch(...)` should support HTTP GET, HEAD, and POST because many read-style APIs use POST bodies for structured queries. ViteHub cannot prove whether a POST mutates remote state, so it should not expose a fake `readOnly` flag. Documentation and DevTools should make POST-backed Sources visible as a trust boundary: developers are responsible for using POST only for stable read targets, while mutation, side-effectful commands, and arbitrary model-parameterized requests remain Capability tools.

Request factories execute in server/runtime context but do not receive app-owned Runtime Env or raw runtime config as callback parameters. Code that needs app-owned Runtime Env should import `useServerEnv()` from `#vitehub/env/server`; Secret Env values are unsealed only at the request boundary. Runtime config may remain an internal integration transport, not the public request-factory API.

The Source definition remains static so Source identity and Source-Backed Paths can be discovered without executing user code. Only `request` may be a static object or zero-argument factory for runtime-sensitive request details such as headers; the entire `fetch(...)` options object should not be a factory in v1.

DevTools and diagnostics should show a redacted request summary for `fetch(...)`, not full resolved request details. Method, origin/path, Source key, Source-Backed Path, cache policy, response status, freshness, decoded type, errors, and whether a runtime request factory exists are useful; headers, query values, request bodies, and known Secret Env underlying values should be hidden or redacted by default.

Live Source item bodies are fetched lazily and are not written into the Workspace Store by default. Cache is disabled by default; when configured, it is separate from the Workspace Store and keyed by source identity, item identity, request variables, projection-affecting options, and workspace or security scope. In-flight dedupe is allowed as an internal optimization but is not a user-facing cache guarantee. Explicit materialization creates a point-in-time Workspace artifact; v1 does not promise real-time synchronization.

Schema-bearing Source and Capability fields use Standard Schema-compatible validators by default, including request inputs, response bodies, Source item metadata, and Capability tool inputs and outputs. JSON Schema is an interoperability artifact for model-provider tool descriptors, OpenAPI export, generated clients, forms, and non-TypeScript integrations. Conversion happens at the adapter or export boundary; if the selected adapter/export requires JSON Schema and no converter exists for a schema, ViteHub fails there with a clear error.

`fetch(...)` v1 should use `schema` for Standard Schema-compatible validation of the decoded response body and `transform` for post-validation shaping of the final Workspace-facing item body. The transformed body type is inferred from the `transform` return type; explicit TypeScript generics are only an escape hatch for inference gaps. Post-transform `outputSchema` and `input`/`output` field names are deferred because they better fit Capability tools or future HTTP contract surfaces than the first Source helper.

For `responseType: "json"`, the Workspace-facing body should be stable pretty JSON after schema validation and optional transform. `fetch(...)` exposes canonical readable Source content, not raw wire bytes; exact wire preservation should require an explicit binary/raw mode.

ViteHub may use hookable and ofetch-aligned lifecycle phases internally, but `fetch(...)` v1 should not expose public lifecycle hooks such as `beforeRequest`, `afterResponse`, or `onError`. Public source fetch hooks should wait for a plugin-level extension boundary and concrete requirements for hook timing, context types, mutability, redaction, retry/cache behavior, validation, transform, and error propagation.
