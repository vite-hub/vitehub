# Database Package

Database Package names ownership boundaries for `@vite-hub/database`.

## Language

**Database Package**:
The package that owns database Integration Options, database discovery, and the generated database runtime surface.
_Avoid_: ORM package, migration package

**Default Database**:
The database used when runtime code does not select a named database.
_Avoid_: Singleton database, global database

**Named Database**:
A configured database addressed by name through the generated database runtime surface.
_Avoid_: Connection string, binding

**Database Definition Mode**:
The project-level choice between one Default Database or a set of Named Databases.
_Avoid_: Mixed databases, optional default

**Database Definition**:
A discovered Definition that configures one Default Database or Named Database.
_Avoid_: Drizzle config, migration config, provider binding

**Database Table Schema**:
The Drizzle table primitives declared inside a Database Definition as the database source of truth.
_Avoid_: Validation schema, migration file

**Database Provider Binding**:
Database-scoped provider wiring stored with a Database Definition.
_Avoid_: Provider selection, database identity, runtime secret

**Live Database Schema**:
The schema currently present in a running database.
_Avoid_: Database Table Schema, migration file

**Generated Validation Schema**:
A Standard Schema-compatible validation surface generated from Database Table Schema.
_Avoid_: Database Table Schema, migration source

**Generated Drizzle Schema**:
An inspectable Drizzle schema artifact generated from Database Table Schema for Drizzle Kit.
_Avoid_: Runtime registry, in-memory schema, hidden migration source

**Drizzle Runtime Surface**:
The generated runtime access point for Drizzle databases and schema.
_Avoid_: Raw client, ORM config

## Relationships

- The **Database Package** owns **Default Database** and **Named Database** configuration.
- **Database Definition Mode** is either one **Default Database** or one or more **Named Databases**, never both.
- A **Database Definition** configures exactly one **Default Database** or **Named Database**.
- A **Database Definition** owns its **Database Table Schema**.
- A **Database Definition** can own a **Database Provider Binding** when the binding attaches provider output to that discovered database identity.
- **Generated Drizzle Schema** is derived from **Database Table Schema**.
- **Generated Validation Schema** is derived from **Database Table Schema**.
- A **Named Database** is selected through the **Drizzle Runtime Surface**.
- A **Live Database Schema** can diverge from **Database Table Schema** when an agent has explicit schema write permission.
- The **Database Package** owns Vite-centered database integration.
- Provider selection stays in DB Integration Options, while **Database Provider Binding** may live in a **Database Definition**.

## Example Dialogue

> **Dev:** "Is a Cloudflare D1 binding the database name?"
> **Domain expert:** "No. The binding is provider wiring. The **Named Database** is the ViteHub name used by the **Drizzle Runtime Surface**."

## Flagged Ambiguities

- Provider bindings were considered database identities - resolved: ViteHub database names are the public identity; provider bindings are integration details.
- Migrations were considered schema discovery - resolved: **Database Schema Sources** describe runtime schema access; migrations remain provider or ORM workflow.
- Agent-written schema changes were considered equivalent to updating **Database Schema Sources** - resolved: explicit schema write permission can change the **Live Database Schema** without updating source schema files.
- Agent DB tools were considered direct adapters over the **Drizzle Runtime Surface** - open: the Agent Package should consume an agent-facing DB primitive handle, and the Database Package should own any adapter from **Named Database** runtime entries to that handle.
- `defineDatabase` was considered a Drizzle or migration wrapper - resolved: use **Database Definition** for the discovered database configuration boundary; Drizzle schema and migrations remain related sources and workflows, not the definition itself.
- Default and named databases were considered mixable in one project - resolved: **Database Definition Mode** is exclusive; a project uses one **Default Database** or all **Named Databases**.
- Database schema was considered a separate source beside the **Database Definition** - resolved: schema belongs inside the **Database Definition** as **Database Table Schema**.
- Standard Schema was considered the authored **Database Table Schema** - resolved: users author **Database Table Schema** with Drizzle primitives, and ViteHub derives **Generated Validation Schema** from it.
- Provider bindings were considered only Integration Options - resolved: **Database Provider Binding** may live in a **Database Definition** to avoid duplicating discovered database names, while global provider selection remains an Integration Option.
- Drizzle Kit was considered against an in-memory generated schema - resolved: use **Generated Drizzle Schema** as an inspectable artifact.
