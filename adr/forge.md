# @vite-hub/forge decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Forge GitHub behavior

`conditional fetch`, `archive download`, `forgeCommitFiles`, `tokenUsername`, `pendingMerge`, `appProvider`, `installationTokens`, `ForgeApiError exports`, `forgeErrorStatus`, `onwarn` in `packages/forge/src/conditional.ts`, `packages/forge/src/gaps/archive.ts`, `packages/forge/src/gaps/commit-files.ts`, `packages/forge/src/gaps/git-credentials.ts`, `packages/forge/src/gaps/merge.ts`, `packages/forge/src/github-app.ts`, `packages/forge/src/index.ts`, `packages/forge/src/provider.ts`, `packages/forge/vite.config.ts`.

**Context:** GitHub rate limits, API limits, auth rules, and forges bundled into the package.

**Decision:** ETag cache only with credentials; codeload for anonymous archives; Git database for empty or authored commits; fixed token user names; wait only for the same merge; one provider per installation with WeakMap tokens; re-export forges error classes; fail the build on unresolved imports.

**Consequences:** Each one guards quota, correctness, or instanceof across copies.
