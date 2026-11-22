# @vite-hub/gateways decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Gateways: explicit undefined credentials fail; Jev retry rule; public diagnostics allowlist

`missingSecret`, `preset`, `cloudflareAccess`, `requestJevWithRetry`, `publicCodes` in `packages/gateways/src/definition.ts`, `packages/gateways/src/presets.ts`, `packages/gateways/src/jev.ts`, `packages/gateways/src/public-diagnostics.ts`.

**Context:** Unset Server Env values arrive as undefined; transport and decode errors are both TypeErrors; some diagnostics carry provider bodies.

**Decision:** A present key wins even when undefined; retry only a TypeError with a cause; only allowlisted codes are public.

**Consequences:** No silent use of another account; decode errors fail fast; new codes stay private until listed.

## `supportedUrls` builds a provider model on a placeholder route

`supportedUrls` in `languageModel`, `packages/gateways/src/ai-sdk.ts`.

**Context:** The AI SDK reads `supportedUrls` from the model before a call and without its request context, while the gateway resolves its URL and key per request from the Server Env. The provider packages expose `supportedUrls` only on a model instance, and building one needs an API key and a base URL.

**Decision:** The getter builds the provider model with the key `unused` and the base URL `https://gateway.invalid`, and returns only its `supportedUrls`. That model never sends a request.

**Consequences:** Keep the placeholder route out of `doGenerate` and `doStream`. It can go when the AI SDK providers export their supported URLs without a model instance.

## `askOnce` forwards instructions through `system`

**Context:** `ask()` can use a model supplied by an app on AI SDK 6. Jev-only apps need not load the AI SDK at all.

**Decision:** Keep the optional AI SDK peer compatible with versions 6 and 7. Pass instructions to `generateText` as `system`, which both versions accept.

**Consequences:** Narrowing the peer would reject working installs, and passing `instructions` instead would silently drop the system message on SDK 6.

## Jev response metadata is parsed at the boundary

`jevResponseMetadata` in `packages/gateways/src/jev.ts`.

**Context:** advocaat types `model` and `usage` as always present, but its TypeSafe protocol returns the parsed JSON body without validating it. A TypeSafe or Cloudflare response can omit both.

**Decision:** `jevResponseMetadata` reads `model` only as a non-empty string and the token counts only as finite numbers, and drops anything else.

**Consequences:** Do not read `result.model` or `result.usage` straight from advocaat. It can go when advocaat validates the TypeSafe response body as it does the Vercel one.

## The Vercel OIDC route sets `ai-gateway-auth-method` itself

`jevRoute` in `packages/gateways/src/presets.ts`.

**Context:** advocaat sends `ai-gateway-auth-method: oidc` only when it reads `VERCEL_OIDC_TOKEN` from the environment itself. ViteHub resolves the token from the Server Env or an option and passes it as `apiKey`, and advocaat has no option to mark a passed key as an OIDC token.

**Decision:** When the key is an OIDC token, `jevRoute` adds the header to the request headers, which advocaat spreads after its own.

**Consequences:** Without the header, Vercel AI Gateway rejects the OIDC token as an API key. It can go when advocaat accepts an auth method option.

## Local gateways send a placeholder API key

`ollama` and `emulate` in `packages/gateways/src/presets.ts`.

**Context:** Ollama and emulate accept any key. `@ai-sdk/openai` and `@ai-sdk/anthropic` throw without one, and `createModel` raises `GATEWAYS_R0002` for a route without a key. Ollama also serves the Codex and Claude Code Drivers, whose CLIs start their sign-in flow when they get no key.

**Decision:** `ollama()` sends the configured key or `ollama`, and `emulate()` always sends `emulate`.

**Consequences:** Do not drop the key or make it required: local Drivers and AI SDK models would stop at sign-in or at `GATEWAYS_R0002`. It can go when the AI SDK providers, and for `ollama()` both CLIs, accept a keyless local endpoint.
