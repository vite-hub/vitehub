# Database decisions

## Check contributed migrations once for a Vite build

`packages/database/src/vite.ts` and `packages/database/test/nuxt-contributed-migrations.test.ts`.

**Context:** Vite starts a build for each environment, but they share the migration history. Nuxt checks that history during `nitro:config`.

**Decision:** Check the history once for a Vite build. The CLI configuration load used by `database generate` does not run the Nuxt build check.

**Consequences:** The check does not repeat across environments, and a developer can generate the missing migration before building.
