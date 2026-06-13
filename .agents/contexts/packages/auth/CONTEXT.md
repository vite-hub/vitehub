# Auth Package

Auth Package names ownership boundaries for `@vite-hub/auth`.

## Language

**Auth Package**:
The package that owns Auth Definitions, mountable auth handlers, server auth runtime helpers, and package-to-package auth bridges.
_Avoid_: Login app, client package, Agent Package

**Auth Handler Owner**:
The Auth Package role that creates the mountable runtime handler for Auth.
_Avoid_: Nitro route package, app route owner, DevTools bridge

**Auth Route Exposure**:
The Auth Package behavior that exposes the Auth handler over HTTP at the Auth Base Path when route exposure is enabled.
_Avoid_: manual route file, Nitro module, app route owner

**Auth Route Exposure Opt-Out**:
The Auth Definition field that disables automatic Auth Route Exposure so the application can mount the Auth handler manually.
_Avoid_: default manual route, Nitro integration switch, disabled auth

**Manual Auth Mount**:
An application-host route that mounts the Auth handler when automatic Auth Route Exposure is unavailable or explicitly disabled.
_Avoid_: required setup, generated route, Better Auth config

**Canonical Auth Route Path**:
The default HTTP route path for Auth.
_Avoid_: ViteHub API namespace, app route path

**Auth Base Path**:
The Auth Definition route metadata that identifies the HTTP route prefix used by Better Auth and client factory metadata.
_Avoid_: baseURL, generated route ownership, runtime origin

**Auth Client Factory Metadata**:
Client construction metadata attached to an Auth Definition for downstream application code.
_Avoid_: Auth Client Definition, client runtime, composable

**Auth Options Surface**:
The top-level Better Auth-compatible portion of an Auth Definition, excluding fields owned by ViteHub package integration.
_Avoid_: nested Better Auth config, wrapper DSL, Vite plugin options

**Auth Reserved Field**:
A top-level Auth Definition field owned by ViteHub instead of passed through to Better Auth.
_Avoid_: raw passthrough, escape hatch, Better Auth override

**Auth Runtime Resolution**:
The Auth Package behavior that supplies runtime-only auth values such as `secret`, `secrets`, and canonical request origins.
_Avoid_: Definition Options, Better Auth config passthrough, static route config

**Auth Database Placement**:
The Auth Definition choice of where Auth-owned tables live, either in the selected application database by default or in an explicit dedicated Auth database.
_Avoid_: Better Auth adapter option, hidden auth database, auth storage mode, Integration Option

**Auth Database Configuration**:
The Auth Definition field that declares Auth Database Placement.
_Avoid_: storage config, Vite plugin database option, Better Auth database passthrough

**Auth Secondary Storage**:
The Auth Definition choice to use a KV Store for Better Auth secondary storage concerns such as sessions, verification records, rate-limit counters, and plugin data.
_Avoid_: default cache, raw KV handle, Better Auth storage passthrough

## Relationships

- The **Auth Package** owns **Auth Definition** shape.
- The **Auth Package** supports one Primary Auth Definition per app for now.
- The **Auth Package** discovers the Primary Auth Definition from Auth Definition Locations.
- Multiple Auth Definition Locations in one app are duplicates, not multiple auth identities.
- An **Auth Definition** configures auth behavior, not runtime-only auth values.
- An **Auth Definition** exposes its **Auth Options Surface** at the top level.
- ViteHub-owned **Auth Reserved Fields** are not part of the **Auth Options Surface**.
- The **Auth Package** owns **Auth Handler Owner** behavior.
- The **Auth Package** owns **Auth Route Exposure** when route exposure is enabled.
- **Auth Route Exposure** is enabled by default.
- An **Auth Definition** can declare **Auth Route Exposure Opt-Out**.
- **Auth Route Exposure Opt-Out** belongs to the **Auth Definition**, not Integration Options.
- **Auth Route Exposure** mounts the Auth Package-owned handler.
- **Manual Auth Mount** is available when automatic **Auth Route Exposure** is unavailable or disabled.
- The **Canonical Auth Route Path** is `/api/auth/**`.
- **Auth Route Exposure** uses the **Canonical Auth Route Path** by default.
- **Auth Base Path** defaults to the **Canonical Auth Route Path** prefix.
- **Auth Base Path** identifies where **Auth Route Exposure** or **Manual Auth Mount** exposes Auth.
- Nitro applications can use **Manual Auth Mount**; Nitro-specific automatic wiring requires revisiting ViteHub's Vite-only framework integration decision.
- The **Auth Package** may expose **Auth Client Factory Metadata** from an Auth Definition.
- **Auth Client Factory Metadata** is not a separate discovered Definition.
- **Auth Runtime Resolution** supplies secrets and base URLs rather than making them Auth Definition fields.
- An **Auth Definition** declares **Auth Database Placement** through **Auth Database Configuration**.
- An **Auth Definition** can declare **Auth Secondary Storage**.
- **Auth Database Placement** defaults to the selected application database so Auth User relationships can stay local to app data.
- **Auth Database Placement** can be implicit only when the project uses a **Default Database**.
- In Named Database mode, **Auth Database Placement** names the target database explicitly.
- A dedicated Auth database is an explicit **Auth Database Placement**, not the default.
- **Auth Secondary Storage** is opt-in even when the KV Package is installed.
- **Auth Secondary Storage** uses the **Default KV Store** only when KV configuration has an implicit default; named KV configuration requires explicit KV Store Selection.
- Future Agent integration should bridge Auth Session and Auth User into Agent Invoker rather than moving Auth ownership into the Agent Package.

## Example Dialogue

> **Dev:** "Should `@vite-hub/agent` own login because agents need callers?"
> **Domain expert:** "No. The **Auth Package** owns authentication; Agent integration consumes an auth bridge into Agent Invoker."
>
> **Dev:** "Should `defineAuth` accept `secret`, `secrets`, and `baseURL`?"
> **Domain expert:** "No. Keep those in **Auth Runtime Resolution** so the Auth Definition stays about auth behavior."
>
> **Dev:** "Should enabling auth silently create a separate `auth` database?"
> **Domain expert:** "No. Use the selected application database by default; choose a dedicated Auth database only when the project wants that isolation."
>
> **Dev:** "Should database placement be a Vite plugin option?"
> **Domain expert:** "No. Declare **Auth Database Placement** in the **Auth Definition** so discovery and generated output agree on the same Auth contract."
>
> **Dev:** "Should Auth database placement be called storage?"
> **Domain expert:** "No. Use **Auth Database Configuration** so the Auth Package can speak directly to the Database Package."
>
> **Dev:** "Should installing KV automatically enable Better Auth secondary storage?"
> **Domain expert:** "No. **Auth Secondary Storage** changes auth behavior, so the **Auth Definition** must opt in."
>
> **Dev:** "If a project has multiple Named Databases, should Auth pick one?"
> **Domain expert:** "No. In Named Database mode, the **Auth Definition** must name the target database."
>
> **Dev:** "Should Better Auth options live under a `betterAuth` object?"
> **Domain expert:** "No. Keep the **Auth Options Surface** at the top level and reserve ViteHub-owned fields."
>
> **Dev:** "Should users bypass ViteHub-owned auth fields with raw Better Auth options?"
> **Domain expert:** "No. **Auth Reserved Fields** belong to ViteHub and do not have a raw passthrough escape hatch."
>
> **Dev:** "Should V1 support multiple Auth Definitions?"
> **Domain expert:** "No. The **Auth Package** supports one Primary Auth Definition per app for now."
>
> **Dev:** "Should `server.auth.ts` be a second named Auth Definition?"
> **Domain expert:** "No. `server.auth.ts` is an Auth Definition Location alias for the singleton Primary Auth Definition."
>
> **Dev:** "Should every app write its own auth route?"
> **Domain expert:** "No. The Auth Package owns **Auth Route Exposure** by default; use **Manual Auth Mount** only when automatic exposure is unavailable or disabled."
>
> **Dev:** "Should Auth route exposure require an explicit enable flag?"
> **Domain expert:** "No. **Auth Route Exposure** is enabled by default; use **Auth Route Exposure Opt-Out** for manual mounting."
>
> **Dev:** "Should route opt-out be a Vite plugin option?"
> **Domain expert:** "No. Declare **Auth Route Exposure Opt-Out** in the **Auth Definition**."
>
> **Dev:** "Should Auth routes live under `/api/_vitehub/auth`?"
> **Domain expert:** "No. Use `/api/auth/**` as the **Canonical Auth Route Path** because Auth is app-facing product infrastructure."
>
> **Dev:** "Is `basePath` the same as `baseURL`?"
> **Domain expert:** "No. **Auth Base Path** is route metadata declared by the **Auth Definition**; `baseURL` belongs to **Auth Runtime Resolution**."

## Flagged Ambiguities

- Auth route ownership was considered application-host ownership - resolved: the Auth Package owns **Auth Route Exposure** by default, while **Manual Auth Mount** remains available.
- **Auth Route Exposure** was considered opt-in - resolved: it is enabled by default, with **Auth Route Exposure Opt-Out** for manual mounting.
- **Auth Route Exposure Opt-Out** was considered as a Vite Integration Option - resolved: it belongs to the **Auth Definition**.
- The Auth route path was considered for the ViteHub API namespace - resolved: use `/api/auth/**` as the **Canonical Auth Route Path**.
- `basePath` was considered runtime origin configuration - resolved: use **Auth Base Path** for route metadata while keeping `baseURL` in **Auth Runtime Resolution**.
- Client support was considered a first-class package surface for V1 - resolved: the **Auth Package** starts server-first and may expose **Auth Client Factory Metadata** without owning framework-specific client helpers.
- Better Auth `secret`, `secrets`, and `baseURL` were considered Auth Definition fields - resolved: keep them under **Auth Runtime Resolution** so secrets and canonical origins can come from Server Env, request origin, or provider runtime state.
- A dedicated Auth database was considered the default **Auth Database Placement** - resolved: co-locate Auth tables in the selected application database by default, with a dedicated Auth database as an explicit choice.
- **Auth Database Placement** was considered as a Vite Integration Option - resolved: it belongs to the **Auth Definition**.
- Auth was considered able to guess the app database in Named Database mode - resolved: Named Database mode requires explicit target database selection in the **Auth Definition**.
- Generic storage language was considered for Auth database placement - resolved: use **Auth Database Configuration** because the placement integrates with the Database Package.
- **Auth Secondary Storage** was considered as an automatic KV integration - resolved: it is an explicit **Auth Definition** choice and targets a KV Store through KV Store Selection.
- Nesting Better Auth options under a wrapper field was considered - resolved: the **Auth Options Surface** stays top-level in the **Auth Definition**.
- Raw Better Auth passthrough was considered for ViteHub-owned fields - resolved: **Auth Reserved Fields** have no raw passthrough escape hatch.
- Multiple Auth Definitions were considered for V1 - resolved: the **Auth Package** supports one Primary Auth Definition per app for now.
- Suffix-style auth files were considered named Auth Definition identities - resolved: `server.auth.ts` is an alias for the singleton Primary Auth Definition, with duplicate locations rejected.
