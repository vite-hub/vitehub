# Migration quarantine

Use this only when the installed application already uses an older composition generation or the user explicitly asks for migration.

## Identify the generation

| Installed shape | Meaning | Direction |
| --- | --- | --- |
| `vite-hub` with feature subpaths | Current application facade | Keep and inspect installed exports |
| Individual `@vite-hub/*` packages with `hubX()` plugins | Supported owner-package composition | Keep for focused/advanced ownership or migrate application composition to the facade |
| `@vite-hub/vite` root preset | Former aggregate application preset | Migrate to `vite-hub` when the installed target supports it |
| `@vitehub/*` | Historical package scope | Do not copy; migrate through current docs and exports |

Read [Migration](https://vitehub.dev/raw/docs/getting-started/migration.md), [Installation](https://vitehub.dev/raw/docs/getting-started/installation.md), and [Import paths](https://vitehub.dev/raw/docs/reference/import-paths.md).

## Migration procedure

1. Record the current package graph, imports, integrations, generated state, and live proof.
2. Install one coherent target graph and inspect its exports/types.
3. Replace the composition boundary first, then feature imports one owner at a time.
4. Remove compatibility aliases and app-local glue whose upstream seam now exists.
5. Rerun the same live proof after each boundary changes.

Migration is complete when no historical import remains, the lockfile contains one intentional graph, generated state matches the target contract, and the original behavior proof still passes.
