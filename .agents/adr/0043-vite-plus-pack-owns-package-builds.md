# Vite+ Pack Owns Package Builds

ViteHub package builds use Vite+ `vp pack` as the package build surface instead of package-local `tsdown` commands. Public package exports should be generated from the package pack entries by default, while Stable ViteHub Import Paths, Runtime Registry imports, and deliberately exposed package-internal paths stay explicit so source file layout does not accidentally become public API.

## Considered Options

- Keeping direct `tsdown` scripts was rejected because Vite+ should own the project development, build, and packaging workflow.
- Letting file layout drive every export was rejected because ViteHub distinguishes generated/public package entries from Runtime Registries, Stable ViteHub Import Paths, and intentional internal package boundaries.

## Consequences

Package-owned build configuration should move toward Vite+ pack configuration. Existing tsdown details such as entry lists, bundled private internals, external virtual modules, copied declaration files, and publish checks should be preserved as pack behavior or explicit boundary exceptions rather than kept as separate package scripts.
