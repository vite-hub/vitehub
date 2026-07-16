# Framework composition

Use this for Vite, Nitro, Nuxt, integration ordering, generated types, or deployment configuration.

## Select one current page

Start with [Vite Integrations and Provider Output](https://vitehub.dev/raw/docs/concepts/vite-integrations-and-provider-output.md). Open [Config options](https://vitehub.dev/raw/docs/reference/config-options.md) only for an option mismatch, or the selected page under [Frameworks and hosts](https://vitehub.dev/raw/docs/frameworks-hosts.md) only for a named framework or deployment target.

## Current application contract

Fresh apps install `vite-hub`, register `vitehub()` from the root, and use feature subpaths for runtime APIs. Direct `hubX()` integrations belong to an installed owner-package contract or deliberate advanced composition.

For Vite plus Nitro, keep ordering explicit:

```text
client/framework plugins
vitehub(...)
nitro(...)
```

For Nuxt, use documented modules or the Vite extension point supported by the installed packages. Do not reproduce app-local aliases or output rewrites from project examples without a source-backed need.

## Generated state

Include `.vitehub/types/**/*.d.ts` when generated names or `#vitehub/*` imports require it. Inspect `.vitehub` during development, but author source Definitions and stable imports rather than generated files.

## Proof

Run prepare/typecheck, build the selected framework, inspect `.vitehub`, and inspect the target's Provider Output. Ordering is proven by generated bindings and a live Runtime Helper or Agent Invocation, not by config shape alone.
