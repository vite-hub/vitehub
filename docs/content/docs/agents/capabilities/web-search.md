---
title: Web search
description: Let an Agent search the web and read pages, through the model provider or through a search provider that you choose.
navigation.title: Web search
navigation.order: 230
navigation.group: Capabilities
icon: i-lucide-search
---

`webSearch()` lets an Agent search the web in one of two modes. It wraps no Server Primitive.

- **Model mode** adds the provider's own `web_search` tool, which the provider runs.
- **Tool mode** adds `web_search` and `web_read`, run by ViteHub through `@agntn/web` and one search provider you configure.

## Configure web search

Use model mode when the provider supports native web search.

```ts [server/agents/research.ts] fragment
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

```ts [server/agents/research.ts] fragment
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

Model mode adds the AI SDK tool `openai.web_search` as `web_search`; the provider runs it and gives results to the model.

Tool mode loads `@agntn/web` on the first call:

- `web_search` queries the provider and returns `title`, `url`, and `snippet` results in one shape.
- `web_read` returns one URL's content as Markdown.

## Credentials

Tool mode reads the API key from:

1. `provider.apiKey`
2. `VITEHUB_<PROVIDER>_API_KEY`
3. `<PROVIDER>_API_KEY`

The provider name is uppercased with non-alphanumerics replaced by underscores, so `my-search` uses `VITEHUB_MY_SEARCH_API_KEY`, then `MY_SEARCH_API_KEY`.

## Tool inputs

Tool mode rejects input properties not listed here.

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

- `mode: 'model'` or `mode: 'tool'`.
- Model mode: a model-backed Driver (the part that runs the model) whose provider supports the `openai.web_search` tool.
- Tool mode: `@agntn/web` in the app and one provider with its credential.

## Security and approval

Both modes send queries to an external service. The credential stays in server code; the Agent sees only inputs and results.

> [!WARNING]
> In tool mode, `web_read` reads any URL, with no domain allowlist. There is no `policy` option, so calls need no approval.

Use [`fetch()`](/docs/agents/capabilities/fetch) to limit the Agent to specific endpoints.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Provider tool in model mode, or `web_search` and `web_read` in tool mode. |
| Provider-backed | Tool mode through the private MCP bridge. Model mode fails: Provider Drivers do not accept Provider Tool contributions. |
| Custom-run-backed | Tool-mode tools in the run context. `driver.run` decides whether to call them. |

## Verify web search

Run `vitehub agent info --agent <name> --json`. In tool mode, `tools` has a `web-search` entry (keyed by Capability id), and a run's trace shows `web_search` or `web_read` calls.

To test the error path, call `web_search` in tool mode without `@agntn/web`. It must fail with a message to install `@agntn/web` or use model mode.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"model" \| "tool"` | required | Provider-native search, or ViteHub search and read tools. |
| `provider` | `WebSearchProviderInput` | required in tool mode | Provider name or options. |
| `provider.name` | `"brave" \| "exa" \| "jina" \| "searxng" \| "serpapi" \| "serpbase" \| "tavily" \| string` | required | Tool-mode web search provider. |
| `provider.apiKey` | `string \| { unseal() } \| function` | environment | Credential, when required. |
| `provider.baseURL` | `string` | provider default | Override the provider endpoint. |

## Related pages

- [fetch()](/docs/agents/capabilities/fetch)
- [Official capabilities](/docs/agents/capabilities/official)
