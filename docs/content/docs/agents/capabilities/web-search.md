---
title: Web search
description: Add model web search or normalized web search and read tools.
navigation.title: Web search
navigation.order: 230
navigation.group: Capabilities
icon: i-lucide-search
---

`webSearch()` gives the Agent web context through one explicit mode.
Model mode adds the provider-native `web_search` tool, and the model provider runs the search.
Tool mode adds `web_search` and `web_read` tools that ViteHub runs through one configured search provider and the `@agntn/web` package.
It does not wrap a Server Primitive.

## Configure web search

Use model mode when the model provider supports provider-native web search.

```ts [server/agents/research.ts]
import { defineAgent } from 'vite-hub/agent'
import { webSearch } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    webSearch({ mode: 'model' }),
  ],
})
```

Use tool mode to choose the search provider. Install `@agntn/web` first.

```bash [Terminal]
pnpm add @agntn/web
```

```ts [server/agents/research.ts]
import { defineAgent } from 'vite-hub/agent'
import { webSearch } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    webSearch({ mode: 'tool', provider: 'tavily' }),
  ],
})
```

## How web search works

Model mode adds the AI SDK provider-defined tool `openai.web_search` under the name `web_search`. The model provider runs the search and returns results to the model.

Tool mode loads `@agntn/web` on the first tool call.
`web_search` sends the query to the configured provider and returns normalized results with `title`, `url`, and `snippet`.
`web_read` reads one URL and returns its content as Markdown.

## Credentials

Tool mode resolves credentials in this order: `provider.apiKey`, `VITEHUB_<PROVIDER>_API_KEY`, then `<PROVIDER>_API_KEY`. ViteHub uppercases the provider name and replaces non-alphanumeric characters with underscores, so `my-search` uses `VITEHUB_MY_SEARCH_API_KEY` before `MY_SEARCH_API_KEY`.

## Tool inputs

Tool mode rejects properties outside these public input contracts.

### `web_search`

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `string` | required | Non-empty search query. |
| `includeDomains` | `string[]` | provider default | Restrict results to these domains. |
| `excludeDomains` | `string[]` | provider default | Exclude these domains from results. |
| `maxResults` | `number` | provider default | Maximum number of search results. |

### `web_read`

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string` | required | Non-empty page URL to read. |
| `maxTokens` | `number` | reader default | Maximum normalized content size. |

## Requirements

`webSearch()` requires `mode: 'model'` or `mode: 'tool'`.
Model mode requires a model-backed Driver whose model provider supports the `openai.web_search` provider tool.
Tool mode requires the application to install `@agntn/web` and to configure one provider with the credential that the provider requires.

## Security and approval

Both modes let the Agent send queries to an external service. Tool mode also lets the Agent read any URL that it passes to `web_read`. There is no domain allowlist for `web_read`.
The credential stays in server code. The Agent sees only tool inputs and results.
`webSearch()` has no `policy` option, so calls run without an approval step. Use [`fetch()`](/docs/agents/capabilities/fetch) when the Agent should reach only specific endpoints.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the provider tool in model mode, or `web_search` and `web_read` in tool mode. |
| Provider-backed | Receives `web_search` and `web_read` through the private MCP bridge in tool mode. Model mode fails because Provider Agent Drivers do not accept Provider Tool contributions. |
| Custom-run-backed | Receives the tool-mode tools in the prepared run context; `driver.run` decides whether to call them. |

## Verify web search

Run `vitehub agent info --agent <name> --json`.
In tool mode, confirm that `tools` contains a `web-search` entry. Entries use the Capability id. Run one invocation and confirm that the trace shows `web_search` or `web_read` calls.

Call `web_search` in tool mode without `@agntn/web` installed during development.
Confirm that the call fails with a message that asks you to install `@agntn/web` or to use model mode.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"model" \| "tool"` | required | Uses provider-native model web search or ViteHub-managed search and read tools. |
| `provider` | `WebSearchProviderInput` | required in tool mode | Provider name or provider options for tool mode. |
| `provider.name` | `"brave" \| "exa" \| "jina" \| "searxng" \| "serpapi" \| "serpbase" \| "tavily" \| string` | required | Tool-mode web search provider. |
| `provider.apiKey` | `string \| { unseal() } \| function` | environment | Credential for providers that require one. |
| `provider.baseURL` | `string` | provider default | Override the provider endpoint. |

## Related pages

- [fetch()](/docs/agents/capabilities/fetch)
- [Official capabilities](/docs/agents/capabilities/official)
