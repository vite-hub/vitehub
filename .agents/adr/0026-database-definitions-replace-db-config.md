# Database Definitions Replace DB Config

ViteHub Database will be rebuilt around discovered **Database Definitions** instead of extending the current config-first DB implementation. Users author **Database Table Schema** with Drizzle primitives inside `defineDatabase`, ViteHub generates inspectable **Generated Drizzle Schema** artifacts for Drizzle Kit and **Generated Validation Schema** surfaces for Standard Schema-compatible validation, and DB CLI workflows such as `vitehub db generate` refresh generated artifacts before invoking Drizzle Kit.

## Considered Options

- Keeping the current top-level `db` plus `db.databases.<name>` config model was rejected because it duplicates discovered names, mixes default and named databases, and makes database identity live in Integration Options instead of discovery.
- Making Standard Schema the authored table source was rejected because Standard Schema is a validation contract and does not carry database metadata required for migrations, indexes, constraints, relations, defaults, generated columns, or dialect-specific DDL.
- Calling Drizzle Kit against in-memory generated schema was rejected because agents and developers must be able to inspect the generated migration source.
- Renaming every public surface to `database` was rejected because `db` remains the clearest shorthand for the CLI namespace, Vite config option, runtime handle, and agent capability tools.
- Using short `db` names for the package and generated artifact root was rejected before 0.0.1 because package names, docs routes, virtual modules, and generated artifact roots should match the long-form Database Package identity.

## Consequences

Database discovery uses location-derived identity and direct default-exported `defineDatabase(...)` files; helper options do not rename databases. Nitro defaults to `server/databases/config.ts` for the **Default Database** and `server/databases/<name>/config.ts` for **Named Databases**, with exclusive **Database Definition Mode**: a project uses one default database or all named databases, never both.

Database-scoped provider binding metadata may live in a **Database Definition** to avoid duplicating discovered names, but global provider selection, CLI assembly, generated output behavior, and provider-wide defaults remain Integration Options. The replacement should build on PR 226's package-contributed CLI model and use `@vitehub/database`, `#vitehub/database/*`, and `.vitehub/database` for package and artifact identity while retaining `db` for operational shorthand such as `vitehub db`, runtime `db` handles, Vite `db` options, and agent DB tools.
