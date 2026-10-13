# Connections

Use Connections when a person or application must connect a provider account with OAuth 2 or an API key, then call that provider through an explicit access policy.

Read the [Connections guide](https://vitehub.dev/raw/docs/connections.md), especially [Get started](https://vitehub.dev/raw/docs/connections/get-started.md) and [Server API](https://vitehub.dev/raw/docs/connections/server-api.md).

Connections require a Database and encryption key policy. Keep provider scopes and operation allowlists visible. A connected account is not automatically available to an Agent or route.

Keep the connected account, actor, and operation scope in the request policy.
Never expose provider tokens to application responses or Agent prompts.

Prove the connect and callback flow, an authorized operation, and a denied operation. Inspect the stored metadata without exposing tokens.
