# vitehub.dev MCP eval

This eval measures how a model uses the MCP server of vitehub.dev (`https://vitehub.dev/mcp`). The server has two read-only tools: `list-pages` and `get-page`. The eval sends fixed prompts to Claude with the live tools and server instructions, then scores the tool calls and the final answer. It uses `runMcpEval()` from `vite-hub/mcp/eval`. See [MCP tool-use evals](https://vitehub.dev/docs/mcp/evals).

[cases.ndjson](cases.ndjson) has 9 cases:

| Kind | Cases | What they check |
| --- | --- | --- |
| `bad` | `queue-get-started`, `general-code-no-docs` | Failures that we saw. Claude Haiku 5.5 answered from `list-pages` without `get-page`. Claude Sonnet 5.5 called `list-pages` for a general TypeScript task. |
| `guard` | `rate-limit-429`, `kv-store-not-found`, `blob-known-path`, `webhooks-debounce`, `schedule-cloudflare` | The model finds the right page and reads it with `get-page`. With a URL in the prompt, it calls `get-page` without `list-pages`. |
| `control` | `control-arithmetic`, `control-http-429` | General questions that need no tool. `control-http-429` is near `rate-limit-429`. |

Each case has an `origin`: the run where we saw the failure, or the docs page that has the answer.

## Run

From `docs/`, build `vite-hub` once (`vp run -t vite-hub#build`), then:

```sh
corepack pnpm run eval:mcp -- --model sonnet
corepack pnpm run eval:mcp -- --model haiku --case queue-get-started --samples 1
corepack pnpm run eval:mcp -- --dry-run
```

`run.ts` uses `@ai-sdk/anthropic`, which reads `ANTHROPIC_API_KEY` and, if it is set, `ANTHROPIC_BASE_URL`. To send the requests through a local proxy, such as CLIProxy, set `ANTHROPIC_BASE_URL` to its `/v1` URL and `ANTHROPIC_API_KEY` to its key. `--model` takes `sonnet` (Claude Sonnet 5.5, the default) or `haiku` (Claude Haiku 5.5). `MCP_URL` changes the server, such as a preview deploy. The other flags are in the [docs](https://vitehub.dev/docs/mcp/evals#run-the-eval).

The dry run makes no model call and needs no API key. Add `--baseline evals/mcp/baseline.json` to check for changes in the tools, server instructions, or cases. The committed [baseline.json](baseline.json) records the original run. A baseline dry run exits with code `1` because `general-code-no-docs`, `rate-limit-429`, `blob-known-path`, and `webhooks-debounce` now use different checks. A model run with `--baseline` compares only cases that have not changed. To refresh the baseline for all cases, run with `--model sonnet --out <dir>` and copy `<dir>/run.json` to `baseline.json`.

The dry run is not in CI. vitehub.dev changes when `main` deploys, not in a pull request, so a pull request check would not test the pull request's changes.

## Cost of a full run

Measured on 2026-11-25 with Claude Sonnet 5.5 through CLIProxy, at commit `2b79f1ebf7` ([baseline.json](baseline.json)):

| | |
| --- | --- |
| Samples | 19 (2 per case, a 3rd for `general-code-no-docs`) |
| Tokens | 1,482,100: input 1,465,726 (cache read 1,457,959, cache write 7,681), output 16,374 |
| Tool calls | 38 (12 `list-pages`, 26 `get-page`), in 43 model steps |
| List price, as measured | $0.33 |
| List price with no prompt cache | $3.10 |

The prices use the Claude Sonnet 5.5 list price on [models.dev](https://models.dev) on 2026-11-25: $2 input, $10 output, $0.10 cache read, and $2.50 cache write for each million tokens. CLIProxy hit the prompt cache for almost all input. `@ai-sdk/anthropic` sets no cache breakpoint, so a run with an Anthropic API key can cost near the $3.10.

`list-pages` returns 151,010 characters (about 40k tokens), and the model sends that result again at each later step. A sample that calls `list-pages` uses about 122k tokens. A sample that calls only `get-page` uses about 5k.

## Original run result

| Case | Kind | Samples | Pass rate | Status |
| --- | --- | --- | --- | --- |
| queue-get-started | bad | 2 | 100% | pass |
| general-code-no-docs | bad | 3 | 33% | fail |
| rate-limit-429 | guard | 2 | 100% | pass |
| kv-store-not-found | guard | 2 | 100% | pass |
| blob-known-path | guard | 2 | 100% | pass |
| webhooks-debounce | guard | 2 | 100% | pass |
| schedule-cloudflare | guard | 2 | 100% | pass |
| control-arithmetic | control | 2 | 100% | pass |
| control-http-429 | control | 2 | 100% | pass |

Sonnet 5.5 calls `list-pages`, then `get-page` 2 or 3 times, for each docs question. It passes `queue-get-started`, which Haiku 5.5 failed. In 2 of 3 samples it called `list-pages` for "Write a TypeScript function that returns a string reversed", then wrote the function without the result.
