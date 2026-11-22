# Docs decisions

## Keep the docs base when a site moves from dir to sources

`packages/docs/src/nuxt.ts`.

**Context:** `sources` defaults to `/docs`, but `dir` can default to `/` when it has no `docs/` folder.

**Decision:** Warn when the default base contains no pages, and let the site select its base explicitly.

**Consequences:** A site whose old base was `/` can keep its navigation by setting `base: '/'` when it migrates.

## Read Content Source pages from memory during template generation

`writeSources` and `readPage` in `packages/docs/src/nuxt.ts`.

**Context:** `nuxi build` clears the build directory after modules load and generates templates before `build:before` writes the source pages again.

**Decision:** Keep the source Markdown by source and file when writing pages to disk. Use it when reading pages for templates.

**Consequences:** Source-backed templates do not depend on generated files being present during template generation.
