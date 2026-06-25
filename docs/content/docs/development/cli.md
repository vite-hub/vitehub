---
title: CLI
description: Run package-owned development workflows through the local Vite config.
navigation.order: 31
icon: i-lucide-terminal-square
---

The ViteHub CLI loads the local Vite config and collects package-contributed command namespaces.
Commands stay owned by the package that understands the workflow, while `vitehub` gives agents and developers one predictable entry point.

## Install and open help

Install the CLI in the app that uses ViteHub packages.
The command reads active Vite plugins, so a missing package integration also means a missing package-owned command.

```bash [Terminal]
pnpm add -D @vite-hub/cli
pnpm vitehub --help
```

Expected help lists available namespaces.
The Agent Package contributes the `agent` namespace when `hubAgent()` is active, and the CLI includes the built-in `provision` namespace.

```txt [Output]
Usage: vitehub <namespace> <feature> [args...]
Available namespaces:
  agent       Agent development workflows.
  provision   Idempotently create missing provider resources.
```

## Commands

| Command | Status | Owner | Use it for |
| --- | --- | --- | --- |
| `vitehub agent eval` | Available | Agent Package | Run discovered Agent Evals through ViteHub defaults. |
| `vitehub agent dev` | Available | Agent Package | Talk to a discovered Agent through a running Vite Development Server. |
| `vitehub provision run` | Available | ViteHub CLI plus package Provision Steps | Create missing provider resources idempotently. |
| Package-specific namespaces | Planned per package | Owning package | Add workflows only when the package has a durable development task. |

## Run Agent Evals

Use `vitehub agent eval` when the proof is Agent behavior, not just TypeScript.
The optional path narrows the Agent Eval Target.

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts --threshold 0.9
pnpm vitehub agent eval --output .vitehub/evals/support.json --hide-table
```

Set `agent.eval.testTimeout` in `vite.config.ts` for long-running model or harness evals.

## Talk to an Agent during development

Start the app's Vite dev server in one terminal.
Then attach the Agent Dev Loop from another terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

Pass a message or `--prompt` for a one-shot invocation, or omit both to enter an interactive session.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support --prompt "/summary"
pnpm vitehub agent dev --agent support -p "/summary"
```

Use `--context` when the invocation needs trusted Agent Invocation Context Values that would normally come from a Channel, route, or webhook.
The file can live anywhere in the app, but colocating it as `server/agents/<agent>/dev.context.json` keeps local Agent fixtures next to the Agent Definition without making them part of production behavior.
It must contain one JSON object.

```json [server/agents/support/dev.context.json]
{
  "actor": {
    "id": "user_123",
    "kind": "developer",
    "label": "Local Developer"
  },
  "workspace": {
    "id": "local-review"
  }
}
```

```bash [Terminal]
pnpm vitehub agent dev --agent support --context server/agents/support/dev.context.json
pnpm vitehub agent dev --agent support --context server/agents/support/dev.context.json -p "/summary"
pnpm vitehub agent dev --agent support --timeout 180000 -p "/summary"
```

Expected output includes the resolved context file path before the Agent Invocation starts.
In interactive mode, type a message or command such as `/summary` at the prompt.

```txt [Output]
Loaded context: /Users/acme/app/server/agents/support/dev.context.json
Connected to support at http://localhost:5173
> /summary
```

## Preview provisioning

Use `--dry-run` before writing Provider resources.
Provision never deletes or mutates existing resources, and non-secret ids are written only when a real run applies actions.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
pnpm vitehub provision run --provider vercel --dry-run
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Unknown ViteHub CLI namespace` | The package Vite Integration is not installed or is disabled. | Add the package's `hubX()` plugin to `vite.config.ts`. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` disables the Agent Eval Runner. | Re-enable the Agent integration option for local development. |
| Agent eval times out | The eval case, model call, or harness run exceeds `agent.eval.testTimeout`. | Increase `agent.eval.testTimeout` in `vite.config.ts` or narrow the eval case. |
| `No Compatible Vite Development Server found` | The app dev server is not running or `--url` points at the wrong port. | Start Vite separately, then pass the dev server URL. |
| Agent Dev Loop request times out | The invocation exceeded the CLI request timeout. | Pass `--timeout <ms>` for the dev-loop command or shorten the Agent work. |
| `Agent Dev Loop context file must contain a JSON object` | The `--context` file is not a JSON object. | Replace the file contents with one object whose keys are Agent Invocation Context Value ids. |

## Next steps

- Use [Agent Evals](/docs/development/agent-evals) for behavior checks.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.
