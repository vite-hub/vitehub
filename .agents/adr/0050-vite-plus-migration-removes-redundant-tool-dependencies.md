# Vite+ Migration Removes Redundant Tool Dependencies

ViteHub's Vite+ migration should remove redundant direct tool dependencies as aggressively as practical. Packages should not keep CLI-only dependencies on tools that Vite+ owns, while explicit dependencies remain only when package source or configuration imports a tool API directly and has not yet been migrated to a Vite+ surface.

## Considered Options

- Keeping direct dependencies on Vite, Vitest, Oxlint, tsdown, and script runners for familiarity was rejected because it weakens Vite+'s role as the project toolchain owner.
- Removing every tool dependency regardless of imports was rejected because package source and configuration must still declare APIs they import until those imports are migrated.

## Consequences

Tooling catalogs and package devDependencies should shrink during the migration. Dependencies such as `tsx` should be removed when their only role was script execution, and package configs should move imports from tool-specific modules to Vite+ where Vite+ provides the supported API.
