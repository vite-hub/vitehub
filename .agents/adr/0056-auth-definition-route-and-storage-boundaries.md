# Auth Definition, Route, and Storage Boundaries

ViteHub Auth starts as a server-first `@vite-hub/auth` package wrapping Better Auth through one **Primary Auth Definition** per app. The Auth Definition exposes Better Auth-compatible options at the top level while reserving ViteHub-owned fields for route exposure, database placement, secondary storage, and runtime resolution.

## Considered Options

- Separate auth server and auth client definitions were rejected because client construction metadata can stay subordinate to the server-owned Auth Definition.
- A dedicated `auth` Named Database by default was rejected because Better Auth-style embedded auth benefits from co-located application database tables for relationships, joins, and migrations. Dedicated auth storage remains an explicit Auth Database Placement.
- Manual auth routes by default were rejected because Better Auth's normal developer experience expects the auth endpoint to exist once auth is configured.
- Nitro-specific auth wiring was rejected under ADR 0040's Vite-only framework integration rule. Nitro apps can still mount the Auth handler manually unless that ADR is revisited.

## Consequences

`defineAuth` owns Auth Database Placement, Auth Secondary Storage, Auth Base Path, and Auth Route Exposure Opt-Out. Auth Route Exposure is enabled by default at `/api/auth/**`, with `route: false` available for Manual Auth Mount. `secret`, `secrets`, and `baseURL` stay runtime-resolved rather than Auth Definition fields, while `basePath` is route metadata. Auth tables co-locate with the selected application database by default; Named Database mode requires the Auth Definition to name the target database. Auth Secondary Storage is opt-in and targets a KV Store through KV Store Selection.

The package should prefer `server/auth.ts` as the canonical Auth Definition location, support `server.auth.ts` as a singleton alias, and reject duplicate Auth Definition locations. Future Agent integration should bridge Auth User/Auth Session into Agent Actor without merging the concepts.
