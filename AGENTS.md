# ViteHub

ViteHub is an ambitious open source project for server primitives and portable Agents across Vite hosts. We are building the missing server layer for the UnJS ecosystem. A good idea is worth exploring. Keep the final contract clear enough that a developer or an Agent can use it without learning the internal machinery first.

You are working with Maxi. Keep the work direct, practical, and easy to review.

## How we work

- Write short, plain English. Use ASD-STE100 language.
- Keep the scope focused. Prefer the smallest change that makes the public contract better.
- Use the existing Vite, Nuxt, Vue, TypeScript, and pnpm stack.
- Prefer inferred types. Do not use `any`.
- Put shared behavior in the package that owns it. Keep product workflows in consumers.
- Preserve other people's changes. Inspect collisions before editing.
- Ask before production work, deployments, live databases, or maintainer servers.
- A direct request to fix, implement, commit, or open a pull request is authorization for that action.

## Project language

ViteHub has Server Primitives, Agent Definitions, Drivers, Invocations, Capabilities, Workspaces, Sources, framework integrations, and generated host output. Use these names consistently. Runtime policy belongs in its owner package. Console code may inspect runtime behavior but must not own it.

Use Better Auth as a reference for composability and UnJS as a reference for host independent runtime behavior. Build primitives that developers should not recreate. Product specific workflows belong in consumers when they can be composed from ViteHub primitives.

## Code map

- `packages/vite-hub/src/`: framework distribution, discovery, generated output, and host integration
- `packages/agent/src/`: Agent Definitions, Drivers, Invocations, and Capabilities
- `packages/runtime/src/`: shared runtime contracts
- `packages/workspace/src/`, `packages/source/src/`: file trees, access, and mounted Sources
- `packages/*/src/`: each Server Primitive or integration
- `docs/`: documentation and the first party website
- `fixtures/`, `test/consumer/`, `test/output/`: consumer and generated output proof

## Before and after a change

Read the nearest package README. Trace contract changes from configuration through generated output, runtime behavior, and consumers. Check every affected host, provider, and configuration form.

From a clean checkout, install the Node version required by `package.json` and the Deno version in [`.deno-version`](.deno-version). Use the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/) for Deno. Then install the workspace dependencies and check the contributor tools:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run preflight
```

`preflight` checks the pinned Deno version. Run it before the full verification gate so a missing or different Deno installation is clear as a setup issue.

Run focused checks for the files you changed. Build the affected package and its dependencies when the change affects runtime or generated output. Do not run repository wide suites unless the task needs them.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run -t vite-hub#build
corepack pnpm --dir packages/vite-hub run test
corepack pnpm --dir packages/vite-hub exec vp test test/<file>.test.ts
corepack pnpm exec vp run verify
```

Use the affected package name in vp targets and its directory in pnpm --dir commands. For example, use @vite-hub/agent#build as the vp target and packages/agent as the --dir path. The verify command is the full local gate and needs the Deno version in .deno-version.

Report what changed, why, what you verified, and any remaining uncertainty. Keep the response in normal prose. Return JSON, HTML, or other machine formats only when the user explicitly asks for that format.

## Pull requests

Keep one concern per pull request. Use a clear conventional title and start the body with the user visible problem and result. Include focused validation. Do not merge, force push, or deploy without explicit authorization. Use an isolated worktree for pull request work and never remove pre existing work.
