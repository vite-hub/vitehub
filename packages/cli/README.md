# @vite-hub/cli

`@vite-hub/cli` runs the development commands contributed by a ViteHub project's active Vite plugins. It loads the local Vite or Nuxt config, combines their command namespaces, and adds the built-in `provision` command.

## Choose the package

Install `vite-hub` in an application that uses the framework distribution. It includes the CLI and publishes both `vitehub` and `vite-hub` as binary names.

```sh
pnpm add vite-hub
pnpm vitehub --help
```

Install `@vite-hub/cli` directly when a library or custom Vite integration needs the command runner without the framework distribution. The standalone package publishes the `vitehub` binary and requires Vite. Install Nuxt too when the project has a Nuxt config but no Vite config.

```sh
pnpm add -D @vite-hub/cli vite
pnpm vitehub --help
```

`@vite-hub/cli` requires Node.js 24 or newer. The current `vite-hub` distribution requires Node.js 24.15 or newer.

## Open project help

Run help from the project root. The CLI loads the project config before it prints help, so only run it in a repository whose config you trust.

```sh
pnpm vitehub --help
```

Every project includes `provision`. Other namespaces appear when their Vite integrations are active.

```txt
Usage: vitehub <namespace> <feature> [args...]

Available namespaces:
  provision    Idempotently create missing provider resources.
```

Open namespace help to see the commands contributed by one integration. Open feature help for its current arguments and defaults.

```sh
pnpm vitehub agent --help
pnpm vitehub agent invocations --help
```

The Agent integration contributes `info`, `dev`, and `invocations`, plus `channels history` and `channels sync`. It adds `eval` only when the project contains an Agent Eval file. Database contributes `generate` and `migrate`, and Workspace contributes `dev`. The Agent and Database integrations can disable their commands through their integration options.

See the [complete command index](https://vitehub.dev/docs/development/cli#commands) for command availability and the task each command performs.

## Run the CLI from code

Use `runViteHubCli()` when another command runner needs ViteHub's config discovery and exit code without starting the binary entry point.

```ts
// scripts/vitehub.ts
import { runViteHubCli } from "@vite-hub/cli";

const exitCode = await runViteHubCli({
  args: ["agent", "invocations", "list", "--json"],
  cwd: process.cwd(),
});

process.exitCode = exitCode;
```

`runViteHubCli()` returns `0` for successful commands and help, or a non-zero code when a command reports failure. It rejects if config loading or a contributor throws. Pass custom `stdout`, `stderr`, `env`, or `spawn` implementations only when the host needs to capture output or control subprocesses.

## Limits and safety

- Root and namespace help is human-readable text, not a structured output contract.
- Help loads and executes the local Vite or Nuxt config. A missing dependency or config error can stop help before it prints.
- Command effects come from the package that contributes the command. Review command-specific help before applying Database migrations, Channel registration changes, or Provider provisioning.
- `provision run` creates missing resources but does not delete or replace existing resources. Start with `--dry-run` and pass a provider explicitly.

Read the [CLI guide](https://vitehub.dev/docs/development/cli) for every public command, examples, and troubleshooting.
