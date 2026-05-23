# Live Workspace Sources

Workspace Sources may be **Materialized Sources** or **Live Sources**. A Live Source exposes read-only addressable files or items through Workspace by resolving reads from its origin on demand, without writing item bodies into the Workspace Store by default. This refines ADR 0009: Sources are not limited to ingestion or materialization, but they remain explicit Workspace declarations, while model-facing actions, query-only operations, and side-effectful tools remain Capabilities.

## Considered Options

- Materializing all external data was rejected because API-backed and MCP-resource-backed origins can be too large, too fresh, or too expensive to copy into the Workspace Store by default.
- Treating MCP/API access only as Capabilities was rejected because read-only addressable resources should also be inspectable through Workspace and DevTools without requiring an Agent-facing tool.
- Calling non-store-backed Sources "Virtual Sources" or "Ephemeral Sources" was rejected because "virtual" collides with Vite's virtual-module vocabulary and "ephemeral" implies unstable identity.
- Requiring every Source to enumerate all keys was rejected because some Live Sources can support direct reads for known Source-Backed Paths without cheap global listing.

## Consequences

Live Source cache policy must be explicit, opt-in, and separate from the Workspace Store. The first implementation may use process-local memory cache and should prefer the repo's existing cache utilities, but the cache does not define Workspace consistency.

Workspace snapshots and diffs remain Store-based and exclude Live Source item bodies unless those items are explicitly materialized. A Live Source must support direct `stat` and `readFile` for known Source-Backed Paths; `list`, `glob`, and `search` are optional, and search hits must resolve to readable Source-Backed Paths.

DevTools should show Live Sources in a separate Sources view first, including Source identity, Mount, cache policy, status, and supported Workspace operations. API-backed and MCP-backed Source implementations are deferred, but they must satisfy the addressable-item contract when introduced.
