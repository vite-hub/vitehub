---
description: "Fix AGENT_MODEL_GATEWAY_UNAUTHENTICATED in ViteHub. A model Driver called the Vercel AI Gateway with no key, or with a key that is not valid."
seo.title: "AGENT_MODEL_GATEWAY_UNAUTHENTICATED: no AI Gateway key"
---

`runAgent()` and `streamAgent()` return `AGENT_MODEL_GATEWAY_UNAUTHENTICATED` when a model Driver, such as `driver: { model: 'openai/gpt-5.1-mini' }`, calls the Vercel AI Gateway and the Gateway rejects the request. `error.cause` keeps the AI SDK `GatewayAuthenticationError`. A chat route answers with `PROVIDER_AUTHENTICATION_FAILED`.

## Why it happens

A model ID in the `provider/model` form goes through the Vercel AI Gateway. The Gateway needs one of these:

- `AI_GATEWAY_API_KEY` in the environment, or `driver.model.apiKey`.
- A Vercel OIDC token, which a Vercel deployment sets and `vc env pull` writes for dev.

None is set, or the key is not valid.

## Fix it

Set the key:

```bash [.env]
AI_GATEWAY_API_KEY=<your AI Gateway key>
```

To run Agents in dev and tests with no key, answer model requests from the AI emulator. Add `agent.models.emulate` rules, as [Run Agents with no AI key](/docs/agents/no-ai-key) shows:

```diff [vite.config.ts]
 vitehub({
+  agent: {
+    models: {
+      emulate: {
+        rules: [{ id: 'greet', match: { textContains: 'hello' }, reply: [{ type: 'text', text: 'Hello.' }] }],
+      },
+    },
+  },
 })
```

The emulator runs only in dev and tests. A production build still needs a key.

## Related

- [Run Agents with no AI key](/docs/agents/no-ai-key)
- [Agent Drivers](/docs/agents/agent-drivers)
