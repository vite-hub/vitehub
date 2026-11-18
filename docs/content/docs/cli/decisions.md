---
title: Decision commands
description: List the Decisions of the app and run one with a text, or print the questions it would send, with the vitehub decisions command.
navigation.title: Decisions
navigation.order: 9
navigation.group: Commands
icon: i-lucide-list-checks
---

`vitehub decisions` lets you try a Decision from the terminal before you wire it into a route. It does not load the project config, so it works when the app does not start.

## Run a Decision

A **Decision** is a `defineChoices()` result that picks options from a text. `decisions list` finds them by file. There is no registry, so the file path is the address.

```sh
pnpm vitehub decisions list
```

```txt [Output]
FILE                              EXPORT    NAME
server/utils/forecast-choices.ts  forecast  forecast

Run one with: vitehub decisions run server/utils/forecast-choices.ts "<text>"
```

The list skips `node_modules`, `dist`, `build`, `coverage`, and dot folders. A file that fails to load is listed with its error, and the command exits with status `1`.

`decisions run <file> <text>` calls `resolve()` with the text and prints the selection as JSON. The gateway call reads the app's keys, such as `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`, from the shell or the project's `.env` files.

```sh
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

With the offline gateway of the [Decisions tutorial](/docs/decisions/get-started), the first command prints:

```json [Output]
{
  "supplier": { "exclude": ["vak"], "include": ["nord"] },
  "chart": { "confidence": 0.8, "ranked": [{ "probability": 0.1, "value": "line" }, { "probability": 0.1, "value": "bar" }], "value": null }
}
```

| Flag | What it does |
| --- | --- |
| `--export <name>` | The export to run when the file has more than one `defineChoices()` export. |
| `--context <json>` | The `context` for `options` functions, such as `'{"tenantId":"t1"}'`. |
| `--inspect` | Print the questions and state of `inspect()` instead of calling the gateway. |
| `--json` | `decisions list` only: print the files as JSON. |

A Decision error prints `{ "error": { "code", "message" } }` and exits with status `1`. See [Decisions server API](/docs/decisions/server-api) for `resolve()` and `inspect()`.

::note
The command loads the file with Vite but without the project config, so imports must use relative paths or package names. Nuxt aliases such as `~~` and auto-imports do not work.
::
