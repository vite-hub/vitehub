# @vite-hub/choices decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Choices CLI skips the project Vite config

`loadModule` in `packages/choices/src/cli.ts`.

**Context:** Loading vite.config runs every plugin.

**Decision:** configFile: false.

**Consequences:** Choices files cannot rely on app aliases.
