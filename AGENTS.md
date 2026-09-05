# ViteHub contributor instructions

ViteHub provides server APIs and portable Agents across Vite hosts. Applications use `vite-hub`; libraries can use the `@vite-hub/*` owner packages. Server Primitives work without Agents. Agents receive selected operations through Capabilities.

## Code map

| Path | Responsibility |
| --- | --- |
| `packages/vite-hub/src/` | Framework distribution, discovery, generated output, and host integration |
| `packages/vite-hub/src/console/` | First-party inspection UI and server routes |
| `packages/agent/src/` | Agent Definitions, Drivers, Invocations, and Capabilities |
| `packages/runtime/src/` | Shared host-independent runtime contracts |
| `packages/workspace/src/`, `packages/source/src/` | File-tree state, access, and mounted Sources |
| Other `packages/*/src/` | Each Server Primitive or integration's implementation |
| `playground/console/` | Real Console UI with synthetic API data |
| `fixtures/`, `test/consumer/`, `test/output/` | Consumer applications and package/host output proof |
| `docs/content/docs/` | User documentation; package READMEs describe package contracts |

## Critical boundaries

- Put shared behavior in the package that owns it. Console inspects runtime behavior; runtime policy stays in its owner package. Product-specific workflows belong in consumers.
- Prefer the final public contract. Before keeping a legacy path, find real callers. A downstream workaround can expose an upstream gap.
- Trace contract changes from configuration through generated output, runtime, and consumers. Cover affected hosts, providers, and configuration forms.
- Keep authority explicit through Capabilities, Workspace access, and Sources. Runtime features must be inspectable through code or CLI.
- Use the existing Vite, Nuxt, Vue, and pnpm stack. Prefer inferred TypeScript types; do not use `any`. Keep comments and public documentation in sync.

## Complete the change

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, focused checks, design, UI, and PR guidance. Start from the latest cited issue, PR, or consumer. State the user-visible result and adjacent behavior to preserve.

One owner integrates and verifies the result. Delegate only bounded, independent work that reduces total effort. Name file ownership first; avoid recursive delegation. When the same approach fails again, inspect the cause before retrying.

Build the affected package and its dependencies before running focused tests. From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run -t vite-hub#build
corepack pnpm --dir packages/vite-hub exec vp test test/console-colocated-skills.test.ts
```

Replace the package and test with the affected owner. [Verification guidance](CONTRIBUTING.md#verify-the-changed-behavior) explains other test layers and the full gate. Backend changes need regression coverage and the original reproduction or nearest real flow. Report what passed, failed, and remains unverified. Do not remove coverage without evidence that its protection is obsolete, redundant, or ineffective.

## Permissions and communication

- Preserve other people's changes. Before cross-repository or live work, state the exact repository, path, branch/PR, and target. Another repository's mention does not authorize edits there.
- Never use production, live databases, maintainer development servers, deployments, or external accounts without explicit approval. Ask before opening a browser or starting a development server unless the task requests it.
- Do not push, create/update PRs, merge, or deploy without authorization for that action. Never force-push. [PR rules](CONTRIBUTING.md#pull-requests) apply when authorized.
- Use an isolated task worktree. Preserve pre-existing work; remove task-created temporary files and worktrees only after their remote state is safe.
- Design and capability questions are read-only. A direct request such as "can you fix this?" authorizes that action. Explain repository-rule conflicts and ask for an exception before acting.
- On "continue", inspect the current branch, PR, worktree, consumer, and deployed state before resuming. Use read-only inspection within existing permissions.
- Write short, plain technical English using ASD-STE100 principles. Avoid filler and em dashes. "Users" are developers; "Agents" are the Agents they define.
