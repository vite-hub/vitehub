# Database Definitions Replace DB Config

ViteHub DB will be rebuilt around discovered **Database Definitions** instead of extending the current config-first DB implementation. Users author **Database Table Schema** with Drizzle primitives inside `defineDatabase`, ViteHub generates inspectable **Generated Drizzle Schema** artifacts for Drizzle Kit and **Generated Validation Schema** surfaces for Standard Schema-compatible validation, and DB CLI workflows such as `vitehub db generate` refresh generated artifacts before invoking Drizzle Kit.

## Considered Options

- Keeping the current top-level `db` plus `db.databases.<name>` config model was rejected because it duplicates discovered names, mixes default and named databases, and makes database identity live in Integration Options instead of discovery.
- Making Standard Schema the authored table source was rejected because Standard Schema is a validation contract and does not carry database metadata required for migrations, indexes, constraints, relations, defaults, generated columns, or dialect-specific DDL.
- Calling Drizzle Kit against in-memory generated schema was rejected because agents and developers must be able to inspect the generated migration source.
- Renaming all public surfaces to `database` was rejected because ecosystem and NuxtHub precedent support `db` for package, CLI, runtime handles, and generated artifact directories while retaining `Database` for domain concepts and documentation.

## Consequences

Database discovery uses location-derived identity and direct default-exported `defineDatabase(...)` files; helper options do not rename databases. Nitro defaults to `server/databases/config.ts` for the **Default Database** and `server/databases/<name>/config.ts` for **Named Databases**, with exclusive **Database Definition Mode**: a project uses one default database or all named databases, never both.

Database-scoped provider binding metadata may live in a **Database Definition** to avoid duplicating discovered names, but global provider selection, CLI assembly, generated output behavior, and provider-wide defaults remain Integration Options. The replacement should build on PR 226's package-contributed CLI model and use `db` for operational surfaces such as `@vitehub/db`, `vitehub db`, runtime `db` handles, and `.vitehub/db` artifacts, while keeping long-form `Database` language for concepts.
