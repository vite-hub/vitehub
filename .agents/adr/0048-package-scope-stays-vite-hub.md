# Package Scope Stays `@vite-hub`

ViteHub packages stay under the `@vite-hub/*` npm scope because the project owns `vite-hub`, not `vitehub`. Build, packaging, documentation, and example migrations should preserve the existing package scope rather than renaming imports during broad manifest work.

## Considered Options

- Renaming packages to `@vitehub/*` was rejected because that scope is not owned by the project.
- Deferring the rename as a later cleanup was rejected because the constraint is ownership, not migration timing.

## Consequences

Future package and documentation work should treat `@vite-hub/*` as the canonical package scope unless package ownership changes.
