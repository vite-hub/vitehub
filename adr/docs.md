# Docs decisions

## Keep the docs base when a site moves from dir to sources

`packages/docs/src/nuxt.ts`.

**Context:** `sources` defaults to `/docs`, but `dir` can default to `/` when it has no `docs/` folder.

**Decision:** Warn when the default base contains no pages, and let the site select its base explicitly.

**Consequences:** A site whose old base was `/` can keep its navigation by setting `base: '/'` when it migrates.
