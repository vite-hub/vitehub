---
title: MCP tool-use evals
description: Send fixed prompts to a model with the live tools of an MCP server, and score which tools it calls.
navigation.title: Evals
navigation.order: 8
icon: i-lucide-clipboard-check
---

An MCP eval connects to a running MCP server, gives its live tool list to a model, and sends fixed prompts. It then scores the tool calls and the final text. Use it to find tool names, descriptions, and results that make a model pick the wrong tool, skip a tool, or read too much.

The eval works with any MCP server over HTTP, not only a ViteHub server. Use the final endpoint URL: the eval does not follow redirects.

## Write the cases

Write one case on each line of an ndjson file:

```json [evals/cases.ndjson]
{"id":"queue-get-started","kind":"bad","origin":{"type":"issue","url":"https://github.com/acme/docs/issues/12"},"prompt":"How do I start with the Queue primitive?","expect":{"calls":[{"tool":"get-page","args":{"path":"~queue"}}],"finalTextMust":["/docs/queue"]}}
{"id":"say-hello","kind":"control","origin":{"type":"synthetic"},"prompt":"Say hello.","expect":{"maxCalls":0}}
```

| Field | Use |
| --- | --- |
| `id` | A unique name. `--case` uses it. |
| `kind` | `bad` for a known failure, `guard` for behavior that must stay, `control` for a prompt that needs no tool. |
| `origin` | An object that tells where the case comes from, such as an issue URL. |
| `prompt` | The user message. |
| `expect` | The checks. All of them must pass. |
| `maxSteps` | Optional. The model steps for this case. The default is 8. |
| `notes` | Optional. Text for people. |

`expect` takes these checks:

- `calls`: tools that the model must call. `args` is partial: each key must match. A key can be a dotted path, such as `filter.section`. A value is an exact value, a substring that starts with `~`, or a regular expression that starts with `re:`.
- `notCalls`: tools that the model must not call.
- `maxCalls`: the most tool calls in the sample.
- `finalTextMust` and `finalTextMustNot`: text that the final answer must or must not contain. Plain text and `~` text match without case. `re:` text is a regular expression.

You can also give the cases as an array, or as a URL.

## Run the eval

Write a script that names the server and the models:

```ts [evals/mcp.ts] fragment
import { anthropic } from '@ai-sdk/anthropic'
import { runMcpEval } from 'vite-hub/mcp/eval'

await runMcpEval({
  server: { url: 'https://docs.example.com/mcp' },
  cases: new URL('./cases.ndjson', import.meta.url),
  models: {
    haiku: anthropic('claude-haiku-4-5'),
    sonnet: anthropic('claude-sonnet-4-6'),
  },
})
```

Install the peers: `ai`, `@ai-sdk/mcp`, and a provider such as `@ai-sdk/anthropic`. Then run the script:

```bash [Terminal]
node evals/mcp.ts --model sonnet
```

The eval reads `tools/list` and the server instructions from the live server. It does not copy a description or a schema. The server instructions go after `system` in the system prompt.

The model sees all tools. The eval runs only tools with `readOnlyHint: true`. For a different tool, the model gets `not executed: tool is not read-only`, and the eval records the call.

| Flag | Use |
| --- | --- |
| `--model <key>` | The model to use. The default is the first key of `models`. |
| `--case <id>` | Run only this case. You can give it more than one time. |
| `--samples <n>` | Run each case `n` times. |
| `--dry-run` | Check the cases against the live tool list. Make no model call. |
| `--max-tokens <n>` | Stop before the next model step or sample when the run used more than `n` tokens. |
| `--out <dir>` | The output folder. The default is `.data/mcp-eval/<time>`. |
| `--baseline <file>` | Compare with the `run.json` of an earlier run. See [Compare with a baseline](#compare-with-a-baseline). |

## Read the result

Without `--samples`, each case runs 2 samples, and a 3rd sample when the first two do not agree. A sample with an error does not count in the pass rate, but its completed steps still count toward the token budget. A case fails when its pass rate is 0.5 or less. The script exits with code `1` when a case fails, has only errors, or does not finish within the token budget.

The output folder has four files:

- `results.jsonl`: one line for each sample, with each tool call, its arguments, the size of its result in characters, the checks, the final text, and the token usage with cache tokens.
- `tools.json`: the raw `tools/list` result.
- `run.json`: the run in one small file, to commit as the baseline.
- `summary.md`: the commit, the model, the tool count, the surface hash, the pass rate of each case, totals for each kind, and the tokens and tool calls.

The summary flags each tool result of more than 50,000 characters. Claude Code moves a result of that size to a file, so the model does not read it in full.

## Compare with a baseline

`run.json` holds what the next run compares with:

```json [evals/baseline.json]
{
  "version": 1,
  "server": "https://docs.example.com/mcp",
  "surface": "3f9c…",
  "model": "sonnet",
  "modelId": "claude-sonnet-4-6",
  "commit": "a1b2c3d",
  "date": "2026-11-25T12:00:00.000Z",
  "cases": [
    { "id": "queue-get-started", "kind": "bad", "hash": "8e1d…", "samples": 2, "passed": 2, "passRate": 1, "status": "pass" }
  ],
  "usage": { "input": 412000, "output": 3100, "cacheRead": 0 },
  "toolCalls": 21
}
```

- `surface` is the sha256 of the `tools` of `tools/list` and the server instructions. It changes when a tool name, description, schema, or annotation changes.
- `hash` is the sha256 of the case's `id`, `kind`, `prompt`, `expect`, and `maxSteps`. `origin` and `notes` do not count.
- `samples` counts the samples without an error, and `passed` counts the samples that passed.

Copy `run.json` from a full run, without `--case`, to the file you commit. Then give that file to `--baseline`.

In a model run, `summary.md` adds a `Baseline` and a `Delta` column next to `Pass rate`. The delta is in points. A case is a regression when it passed every baseline sample and its pass rate is now 0.5 or less. The summary warns when the baseline used a different model key. Compare runs of the same model. The baseline does not change the exit code of a model run.

In a dry run, the eval compares the live surface and the cases with the baseline, with no model call. It exits with code `1` when the surface is different, or when a case was added, removed, or changed. It exits with code `0` when both match.

### Run it in CI

A model run costs tokens, so run it on your machine and commit the result:

```bash [Terminal]
node evals/mcp.ts --model sonnet --out .data/mcp-eval/latest
cp .data/mcp-eval/latest/run.json evals/baseline.json
```

On each pull request, CI runs the dry run. It uses no tokens and needs no API key:

```bash [Terminal]
node evals/mcp.ts --dry-run --baseline evals/baseline.json
```

When the dry run fails, the tools or the cases changed. Run the eval with a model again and commit the new `baseline.json`.

## Check the tool list

Use `check` to add your own rules for the tool list. It gets the raw `tools/list` result and returns findings:

```ts [evals/mcp.ts] fragment
await runMcpEval({
  // ...
  check: ({ tools }) => tools
    .filter(tool => !tool.annotations?.readOnlyHint && !tool.description?.includes('delete'))
    .map(tool => ({ tool: tool.name, message: 'Say what the tool changes.' })),
})
```

The summary and the dry run show the findings. Findings do not change the exit code.

A dry run fails with exit code `1` when a case names a tool that is not in the list, or an argument key that the tool's input schema rules out.

## Limits

- `@ai-sdk/mcp` adds `additionalProperties: false` to each input schema before the model sees it. Claude Code and other clients send the schema as the server lists it. A model can act differently on the two schemas.
- The eval connects over HTTP only.
- The eval does not run tools that change data, so it cannot score what happens after such a call.
