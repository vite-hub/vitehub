# @vite-hub/connections

`@vite-hub/connections` connects one provider account to an application with OAuth 2 and lets server code and Agents call that provider. Each call checks access rules, refreshes the access token when necessary, and records activity without request or response bodies.

Most ViteHub applications should install the `vite-hub` framework distribution and use `vitehub({ connections: true, database: true })` with the `vite-hub/connections` imports. Install this owner package directly when you are building a library, a custom framework integration, or another focused composition.

## Install the owner package

```sh
pnpm add @vite-hub/connections @vite-hub/database
```

The package requires Node.js 24 or newer. `@vite-hub/database` is a peer: Connections store grants and activity in a Database. Vite is an optional peer and is needed only for Connection Definition discovery.

## Define a Connection

The file path below `server/connections` is the Connection name. The file below defines the `google` Connection:

```ts
// server/connections/google.ts
import { defineConnection } from "@vite-hub/connections";
import { google } from "@vite-hub/connections/google";

export default defineConnection({
  provider: google({
    client: () => ({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET }),
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  }),
  access: {
    server: { allow: ["gmail.*"] },
    agents: { labeller: { allow: ["gmail.messages.*"], approve: ["gmail.drafts.create"] } },
  },
});
```

Access rules check `deny`, then `approve`, then `allow`. When no pattern matches, reads are allowed and writes are denied. `approve` makes the call fail with `CONNECTIONS_APPROVAL_REQUIRED`.

The low-level server runtime accepts `actor` and `approved` from trusted integration code. It does not authenticate callers or collect approvals. Set `approved` only after approval for the exact call and Operation, and never copy it from HTTP requests or Agent tool input. Agent Capabilities are trusted server code; their tool input is untrusted.

Use `oauth2()` from `@vite-hub/connections` for other OAuth 2 providers. Its required `origins` option lists the API origins that may receive the token, for example `["https://api.example.com"]`. Calls to other origins fail with `CONNECTIONS_ORIGIN_NOT_ALLOWED`.

## Call the provider

```ts
import { useConnection } from "@vite-hub/connections";
import { gmail } from "@vite-hub/connections/google";

const connection = useConnection("google", { event });
const labels = await gmail(connection).labels.list();
const response = await connection.fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile");
```

`call()` runs a typed Operation with an `id` and an `effect`. `fetch()` treats `GET` and `HEAD` as reads and other methods as writes. With `dryRun: true`, write calls return without calling the provider.

## Register the Vite integration

```ts
// vite.config.ts
import { hubConnections } from "@vite-hub/connections/vite";
import { hubDb } from "@vite-hub/database/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubDb(), hubConnections()],
});
```

Register `hubDb()` too. Without a configured Database, every Connection call fails with `CONNECTIONS_NOT_CONFIGURED`. The integration discovers `server/connections/<path>.ts`, writes registry types to `.vitehub/types/connections.d.ts`, and generates `#vitehub/connections/runtime`. The generated runtime reads grants from the `default` Database and the key from the secret `VITEHUB_CONNECTIONS_KEY`. The key is 32 random bytes in base64url.

Without the Vite integration, create the runtime yourself and install it with `setConnectionsRuntime()` from `@vite-hub/connections/server`:

```ts
import { createConnectionsRuntime, setConnectionsRuntime } from "@vite-hub/connections/server";

setConnectionsRuntime(createConnectionsRuntime({
  database: () => db,
  encryptionKey: () => process.env.VITEHUB_CONNECTIONS_KEY,
  registry: { google: () => import("./server/connections/google.ts") },
}));
```

## Connect an account

`createConnectionsHandler()` from `@vite-hub/connections/http` handles the management route and the OAuth connect and callback routes. It does not add authentication. The ViteHub Console mounts it under `/_vitehub/connections` behind Console Auth. Mount it only behind your own admin guard.

## Understand storage and security limits

- Grants are sealed with AES-GCM in the `vitehub_connection_grants` table. A different key makes every Connection need a reconnect.
- The connect flow uses PKCE, a single-use ticket, and a `state` cookie. Tokens never reach the browser.
- Activity in `vitehub_connection_activity` has the actor, Operation, outcome, status, duration, target host and path, and trace ids. It has no bodies, headers, query strings, or tokens.
- Refresh uses a database lease, so concurrent requests do not use a rotating refresh token twice.
- One Connection name holds one account. Connections do not sign in users.

Read the [Connections guide](https://vitehub.dev/docs/server-primitives/connections) for the Console, CLI, Agents, and error codes. Use the [public import reference](https://vitehub.dev/docs/reference/import-paths) when composing the owner package directly.
