# @vite-hub/markdown-template decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Markdown template: no fs at module load, decoded link checks, no data in on* or srcdoc

`renderMarkdownFile`, `safeLinkDestination`, `rejectBoundEventHandlers`, `sanitizeUrlAttributes` in `packages/markdown-template/src/file.ts`, `packages/markdown-template/src/links.ts`, `packages/markdown-template/src/render.ts`.

**Context:** Workers have no fs; browsers decode entities; on* and srcdoc run as script or HTML.

**Decision:** Lazy fs import; policy on decoded value; reject bound data on these attributes.

**Consequences:** Works on Workers; no XSS through data bindings.
