# Named Dependency Catalog Taxonomy

External dependency versions in package manifests should use named pnpm catalogs rather than direct versions or the unnamed `catalog:` namespace. Catalog names should primarily follow package families or clear ownership boundaries, such as `unjs`, `vite`, `nuxt`, `storage`, `database`, `workflow`, `workspace`, `sandbox`, `vercel`, `ai`, and `chat`, while shared development dependencies can live under `tooling`.

## Considered Options

- Broad abstract buckets such as `backend`, `frontend`, `build`, `test`, and `types` were rejected because they hide why a package belongs there and make future additions depend on fuzzy categories.
- One-package catalogs are discouraged unless they encode an intentional compatibility or version boundary, such as `nitro-compat`, `vite8-compat`, or `esbuild-v27`.
- `capabilities` was rejected as a catalog name for AI SDK peer ranges because **Capability** is ViteHub product language for model-facing agent abilities, not dependency grouping.

## Consequences

Internal `@vite-hub/*` package links should stay as `workspace:*`. Future dependency changes should add external packages to an existing package-family catalog when the ownership is clear, create a new package-family catalog when a real family emerges, or use a narrowly named `*-compat` or version catalog only when the range itself is the important boundary.
