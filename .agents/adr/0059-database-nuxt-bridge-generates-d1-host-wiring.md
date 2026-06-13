# Database Nuxt Bridge Generates D1 Host Wiring

## Status

Accepted.

## Context

ADR 0040 keeps ViteHub's public Framework Integration surface Vite-only. The Database Package already owns Cloudflare D1 Provider Output for discovered Database Definitions, but downstream Nuxt apps using Nuxt Content exposed a different gap: the app had to repeat one D1 database resource as Nuxt Content runtime config and as `nitro.cloudflare.wrangler.d1_databases`.

A pure helper that returns both object shapes is not enough. It still makes the app compose framework-specific host plumbing, and it exposes Nuxt Content as a Database API concern.

Nuxt Content also consumes its `content.database` option during Nuxt module setup. A Vite plugin can own generated ViteHub Database output, but it is not the reliable lifecycle surface for configuring Nuxt Content's top-level module options.

## Decision

The Database Package may expose `@vite-hub/database/nuxt` as a narrow Nuxt lifecycle bridge for Database-owned host wiring.

This exception is limited to a top-level D1 Database Host Resource:

```ts
export default defineNuxtConfig({
  modules: ['@vite-hub/database/nuxt', '@nuxt/content'],
  database: {
    driver: 'd1',
    databaseName: 'app-content',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    binding: 'DB',
  },
})
```

The bridge may:

- install the Database Vite Integration when it is not already present;
- configure Nuxt Content's database from the D1 resource;
- use local sqlite for Nuxt Content during dev;
- merge the same D1 resource into Cloudflare `wrangler.d1_databases`;
- replace an existing generated D1 binding with the same binding name to avoid duplicates.

The bridge must not expose Nuxt Content as public Database language. Users declare one D1 database resource; Nuxt Content is a consumer behind the bridge.

This does not create general Nuxt database support, Nitro-specific Database discovery, a public `@vite-hub/database/nitro` export, or a second app database identity system. Discovered Database Definitions remain the source for the Drizzle Runtime Surface. A Database Host Resource is only host wiring unless a later ADR explicitly connects it to a Database Definition.

## Consequences

Nuxt apps should not call a `resolveCloudflareNuxtContentDatabase()` helper or manually repeat normal Nuxt Content D1 bindings under `content.database` and `nitro.cloudflare.wrangler.d1_databases`.

Cloudflare `d1_databases` still exists in final generated provider output. The app stops hand-authoring it because the Database Package owns the Provider Output merge from the D1 resource declaration.

ADR 0040 remains the public Framework Integration rule. This decision adds a narrow Database exception because Nuxt module timing is required to hide framework-specific Content database wiring from user config.
