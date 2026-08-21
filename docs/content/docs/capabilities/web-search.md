---
title: Web search
description: Add model web search or normalized web search and read tools.
navigation.title: Web search
navigation.order: 130
navigation.group: External context
icon: i-lucide-search
---

`webSearch()` gives an Agent access to web context through an explicit mode.
Use model mode for provider-native web search, or tool mode for normalized `web_search` and `web_read` tools.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

Model mode contributes a provider tool request for `web_search`.
Tool mode contributes `web_search` and `web_read` model-facing tools backed by a single configured search provider.

## Configuration

Use model mode when the selected model provider supports provider-native web search.
Tool mode requires a web search provider configuration.

```ts [server/agents/research.ts]
import { defineAgent } from '@vite-hub/agent'
import { webSearch } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  capabilities: [
    webSearch({ mode: 'model' }),
  ],
})
```

## Runtime behavior

Model mode adds a Provider Tool contribution and leaves search execution to the model provider.
Tool mode loads the configured provider, executes normalized search requests, and reads URLs as Markdown or text.

## Requirements

`webSearch()` requires `mode: 'model'` or `mode: 'tool'`.
Model mode requires an Agent Driver and model provider that support the provider tool.

Tool mode requires the application to install `askweb` and configure one web search provider with any required credentials.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the provider tool in model mode or `web_search` and `web_read` in tool mode. |
| Provider-backed | Receives `web_search` and `web_read` through the provider MCP bridge in tool mode. Model mode is unsupported because Provider Agent Drivers do not accept Provider Tool contributions. |
| Custom-run-backed | Receives prepared context; `driver.run` decides how to perform web access. |

## Inspect and verify

Inspect provider tool contributions for model mode or the Agent tool list for tool mode.
Tool mode should expose `web_search` and `web_read`.

Run tool mode without `askweb` during development.
The Capability should report the missing package and suggest model mode as the alternative.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"model" \| "tool"` | required | Uses provider-native model web search or ViteHub-managed search/read tools. |
| `provider` | `WebSearchProviderInput` | required in tool mode | Provider name or provider options for tool mode. |
| `provider.name` | `"brave" \| "exa" \| "jina" \| "searxng" \| "serpapi" \| "serpbase" \| "tavily" \| string` | required | Tool-mode web search provider. |
| `provider.apiKey` | `string \| unsealer \| function` | environment | Credential for providers that require one. |
| `provider.baseURL` | `string` | provider default | Override provider endpoint. |

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

## Reference

- [Official capabilities](/docs/capabilities/official-capabilities)
- [fetch()](/docs/capabilities/fetch)
- Source: `packages/agent/src/capabilities/web-search/index.ts`
