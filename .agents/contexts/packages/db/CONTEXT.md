# DB Package

DB Package names ownership boundaries for `@vitehub/db`.

## Language

**DB Package**:
The package that owns database Integration Options, database discovery, and the generated database runtime surface.
_Avoid_: ORM package, migration package

**Default Database**:
The database used when runtime code does not select a named database.
_Avoid_: Singleton database, global database

**Named Database**:
A configured database addressed by name through the generated database runtime surface.
_Avoid_: Connection string, binding

**Database Schema Source**:
The source files that describe a database schema for generated runtime access.
_Avoid_: Migration, table list

**Live Database Schema**:
The schema currently present in a running database.
_Avoid_: Database Schema Source, migration file

**Drizzle Runtime Surface**:
The generated runtime access point for Drizzle databases and schema.
_Avoid_: Raw client, ORM config

## Relationships

- The **DB Package** owns **Default Database** and **Named Database** configuration.
- A **Named Database** is selected through the **Drizzle Runtime Surface**.
- A **Database Schema Source** belongs to one configured database.
- A **Live Database Schema** can diverge from **Database Schema Sources** when an agent has explicit schema write permission.
- The **DB Package** owns Vite-centered database integration until a Nitro boundary is explicitly designed.
- Provider-specific database details stay behind DB Integration Options and generated runtime output.

## Example Dialogue

> **Dev:** "Is a Cloudflare D1 binding the database name?"
> **Domain expert:** "No. The binding is provider wiring. The **Named Database** is the ViteHub name used by the **Drizzle Runtime Surface**."

## Flagged Ambiguities

- Provider bindings were considered database identities - resolved: ViteHub database names are the public identity; provider bindings are integration details.
- Migrations were considered schema discovery - resolved: **Database Schema Sources** describe runtime schema access; migrations remain provider or ORM workflow.
- Agent-written schema changes were considered equivalent to updating **Database Schema Sources** - resolved: explicit schema write permission can change the **Live Database Schema** without updating source schema files.
