---
title: Decision commands
description: List the Decisions of the app and run one with a text, or print the questions it would send, with the vitehub decisions command.
navigation.title: Decisions
navigation.order: 9
navigation.group: Commands
icon: i-lucide-list-checks
---

The `decisions` namespace comes from the framework. It does not load the project config, so it works when the app does not start.

## Run a Decision

A Decision is a `defineChoices()` result that picks options from a text. `decisions list` finds files that call `defineChoices()`, loads them, and prints the exports that hold the result. It skips `node_modules`, `dist`, `build`, `coverage`, and dot folders. There is no registry: the file path is the address. A file that fails to load is listed with its error, and the command exits with status `1`.

```sh
pnpm vitehub decisions list
```

```txt [Output]
FILE                              EXPORT    NAME
server/utils/forecast-choices.ts  forecast  forecast

Run one with: vitehub decisions run server/utils/forecast-choices.ts "<text>"
```

`decisions run <file> <text>` loads the file, calls `resolve()` with the text, and prints the selection as JSON. It calls the definition's gateway, so it reads the app's keys, such as `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`, from the shell or the project's `.env` files. `--inspect` prints the questions and state that `resolve()` would send, without a model call.

```sh
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

The first command's output, with the offline gateway of the [Decisions tutorial](/docs/decisions/get-started):

```json [Output]
{
  "supplier": { "exclude": ["vak"], "include": ["nord"] },
  "chart": { "confidence": 0.8, "ranked": [{ "probability": 0.1, "value": "line" }, { "probability": 0.1, "value": "bar" }], "value": null }
}
```

| Option | Meaning |
| --- | --- |
| `--export <name>` | The export to run when the file has more than one `defineChoices()` export. |
| `--context <json>` | The `context` for `options` functions, such as `'{"tenantId":"t1"}'`. |
| `--inspect` | Print the plan of `inspect()` instead of calling the gateway. |
| `--json` | `decisions list` only: print the files as JSON. |

A Decision error prints `{ "error": { "code", "message" } }` and exits with status `1`. The command loads the file with Vite but without the project config, so imports must use relative paths or package names. Nuxt aliases such as `~~` and auto-imports do not work. See [Decisions server API](/docs/decisions/server-api) for `resolve()` and `inspect()`.

