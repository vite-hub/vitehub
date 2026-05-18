# Agent Memory

ViteHub will add durable agent memory as the `memory()` Official Capability, separate from `chat({ history })`. Memory is a structured, scoped, adapter-backed record system; the first implementation will be a Workspace JSONL Memory Store so the v0 remains inspectable and reversible without baking files, markdown, or `basicMemory()` into the public concept.

## Considered Options

- Extending Chat History was rejected because thread replay and durable records have different lifetimes, scopes, deletion semantics, and privacy risks.
- Naming the feature `basicMemory()` was rejected because it makes a temporary implementation size look like the domain concept.
- Making markdown the public memory abstraction was rejected because ViteHub needs stable record, scope, policy, and adapter language before it adds richer stores such as SQLite, D1, vector, graph, or managed memory providers.

## Consequences

The Memory API should stabilize around Memory Stores, Memory Records, Memory Scopes, Memory Kinds, read/write policies, and tool exposure. The v0 can ship only one store and a small tool set, but the public shape should leave room for future backends and retrieval strategies.

## Future Work

- Add a lower-authority advisory context surface so retrieved semantic and episodic Memory does not have to be injected as system instructions.
- Expand Memory Store adapter capabilities to declare search mode, optimistic concurrency, export guarantees, delete guarantees, compaction support, and managed-provider limits.
- Add policy hooks for redaction, secret filtering, sensitive-data denial, approval routing, and write observability before Memory Records are persisted.
- Add mutation operations beyond append and soft delete, including version-aware update, supersede, list, export, ingest, and compact flows.
- Add stronger stores for concurrent and hosted runtimes, such as SQLite, D1, Durable Objects, vector indexes, graph stores, and managed providers.
- Add admin and DevTools surfaces for reviewing, exporting, deleting, and auditing Memory Records without asking the model to inspect raw storage.
- Keep user-scoped, tenant-scoped, automatic extraction, background consolidation, vector retrieval, and graph/temporal Memory out of v0 until the scoped record model and policies are stable.
