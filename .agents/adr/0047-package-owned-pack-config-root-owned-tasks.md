# Package-Owned Pack Config, Root-Owned Tasks

ViteHub packages own their Vite+ `pack` configuration in package-local `vite.config.ts` files, while the workspace root owns cross-package Vite+ task orchestration. Package-local pack config carries package-owned entrypoints, externals, copied declarations, internal export exceptions, and publish checks; the root config coordinates workflows such as build, verify, and live provider validation.

## Considered Options

- Centralizing every package's pack configuration in the root Vite+ config was rejected because it would make the root workspace own package-specific public API and bundling boundaries.
- Keeping package-local `tsdown.config.ts` files as the package build contract was rejected by ADR 0043; package-local ownership remains, but the build surface moves to Vite+.

## Consequences

Each package that publishes build output should expose its package build shape through local Vite+ pack config. Shared helpers may be introduced later, but only when they reduce real duplication without hiding package-specific boundaries.
