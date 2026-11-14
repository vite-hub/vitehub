---
title: CLI troubleshooting
description: "Find the cause and the fix of common vitehub CLI failures: missing namespaces, provider credentials, dev server lookup, and Agent Dev Loop errors."
navigation.title: Troubleshooting
navigation.order: 15
navigation.group: Operate
icon: i-lucide-life-buoy
---

Find the symptom, then apply the fix. Every CLI error code has its own page in the [CLI diagnostics](/docs/cli/diagnostics), with the source that raises it. The [Project](/docs/cli/project) and [Link and deploy](/docs/cli/deploy) pages list the Setup codes of each command.

## Common failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Unknown ViteHub CLI namespace` | The package plugin is missing or off. | Turn the feature on in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`, or add the package's `hubX()` plugin to `vite.config.ts`. |
| `Unknown Definition kind` | No active package has that kind. | Use a kind from the printed list, or turn on the package. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Provision dry-run reports no actions | A package plan skipped the provider lookup, because its read credentials are missing. | Set the provider credentials. `--dry-run` still blocks `apply()`. |
| Vercel Provision reports no resources for Blob | `VERCEL_PROJECT_ID` is missing, or the Blob store is not `vercel-blob`. | Set the project id and the Vercel Blob driver, then run again. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` turns off the eval runner. | Turn the option back on for local development. |
| Agent eval times out | The eval case, model call, or provider run takes longer than `agent.eval.testTimeout`. | Raise `agent.eval.testTimeout` in `nuxt.config.ts` or `vite.config.ts`, or make the case smaller. |
| Vite config fails to load a ViteHub plugin import | A new npm project loads `vite.config.ts` as CommonJS, but ViteHub packages are ESM-only. | Set `"type": "module"` in `package.json` or rename the config to `vite.config.mts`. |
| `No Compatible Vite Development Server found` | The dev server is not running, or `--url` has the wrong port. | Start Vite, then pass the dev server URL. |
| `CLI_R0005` from an operation command | No dev server wrote `.vitehub/dev-server.json`, and `VITEHUB_DEV_SERVER_URL` is not set. | Start `vite dev` in this project, or pass `--url`. |
| `INTERNAL_R0025` from an operation command | The server at the URL runs another project. | Start `vite dev` in this project, or pass the right `--url`. |
| `CLI_R0003: --url is the app URL, not the Console URL` | `--url` has a `/_vitehub` path. | Pass the app URL that the message names. The command adds the Console path. |
| `AGENT_R1053` from `vitehub agent invocations` | `--url` is a Console URL, or a localhost URL with no Console. This old form stops working in the next minor version. | Pass the app URL, or `--server <url>` for the dev server. |
| `INTERNAL_R0024` from an operation command | The command could not reach the app, or the app refused the signature. | Start `vite dev`, or pass `--url` and set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. |
| `vitehub schedule run` fails with `SCHEDULE_DEFINITION_NOT_FOUND` | The Definition does not set `manual: true`, is not found, or the Console did not install it because `console.invoke` is off. | Set `manual: true`, and keep `console.invoke` on. |
| `vitehub schedule run` fails with `SCHEDULE_MANUAL_RUN_DISABLED` | The Definition exists but does not set `manual: true`. | Set `manual: true` in `defineSchedule()`. |
| `vitehub schedule run --at` fails with `SCHEDULE_INVALID_SCHEDULED_AT` | The time has no time zone or no time, or the day does not exist. | Pass an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00Z`. |
| `Unknown Workspace Dev target` | The dev server did not find that Workspace. | Check the Workspace Definition name and that `hubWorkspace()` is active. |
| `Agent Dev Loop command requires workspace.mode: "write"` | A `!` command targeted an Agent without a writable Workspace. | Give the Agent `workspace: { mode: 'write' }`, or send a normal message. |
| Agent Dev Loop request times out | A streamed invocation sent no events before the inactivity timeout, or a Capability CLI or Workspace command passed its deadline. | Pass `--timeout <ms>`, or look at the stalled work. |
| `Agent Dev Loop --input must be a JSON object` | The `--input` value or file is not a JSON object. | Pass one object shaped for the selected Agent Trigger. |
