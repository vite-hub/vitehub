# Web Search Capability Shape

ViteHub will expose one `webSearch()` factory from `@vite-hub/agent/capabilities`, with an explicit `mode: "tool" | "model"` option. Tool mode contributes ordinary ViteHub tools for `web_search` and `web_read` backed by one explicit search provider, while model mode asks the selected Agent Model Adapter to enable provider-native model web search through an adapter-agnostic and provider-agnostic ViteHub contract.

## Considered Options

- Separate `webSearch()` and `nativeWebSearch()` helpers were rejected because they split one user-facing ability into competing capability names.
- A `nativeModel` provider value was rejected because model web search is an execution mode, not an external tool search provider.
- Defaulting the mode was rejected because tool mode and model mode have different output guarantees, provider requirements, and adapter behavior.
- A separate `@vite-hub/agent/web` public entrypoint was rejected for the first version because recent capability work keeps factories discoverable through `@vite-hub/agent/capabilities` while moving implementation into feature-owned internal modules.

## Consequences

`webSearch({ mode: "tool", provider })` returns normalized structured tool results and URL-read content, using camelCase tool input fields. `webSearch({ mode: "model" })` contributes no `web_read` tool and preserves model/provider web-search metadata through the normal Agent result path when the adapter exposes it. Unsupported model-mode adapter, model, or provider combinations fail early; TanStack AI is not supported for model mode until ViteHub has an adapter-native provider-tool contribution path.
