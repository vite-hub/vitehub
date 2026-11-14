# @vite-hub/channels

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fchannels&icon=npm)](https://npmx.dev/package/@vite-hub/channels)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fchannels&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/channels)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`@vite-hub/channels` defines Channels: one connection to a platform, such as Slack, Teams, Stripe, or your own API, for messages in both directions. A Channel sends through its adapter, and a Channel with an HTTP sender adapter receives webhooks and sends each event to a target.

Most ViteHub applications should install the `vite-hub` framework distribution and use its `vite-hub/channels` imports. Install this owner package directly when you are building a library, a custom framework integration, or another focused composition.

## Install the owner package

```sh
pnpm add @vite-hub/channels
```

The package requires Node.js 22.18 or newer. Vite is an optional peer and is needed only for Channel discovery.

## Send through an explicit Channel

Use `createChannel()` when application code already has the Channel and does not need file discovery.

```ts
import { createChannel, defineChannel } from "@vite-hub/channels";

const delivered: string[] = [];

const alerts = createChannel(
  "alerts",
  defineChannel({
    adapter: {
      kind: "log",
      send(text: string, options: { label: string }) {
        delivered.push(`[${options.label}] ${text}`);
        return { id: "message-1" };
      },
    },
  }),
);

const [error, receipt] = await alerts.send("Build finished.", { label: "release" });
if (error) throw error;
```

The adapter receives `Build finished.` and the original options object. Channels keeps object identity, methods, and private state. The call adds the Channel name and a new delivery ID to the adapter result:

```json
{
  "channel": "alerts",
  "deliveryId": "9ece8118-5937-42f3-90a2-379e39ee151e",
  "id": "message-1"
}
```

`deliveryId` is a new UUID for every send. It identifies the attempt in logs and results; it does not deduplicate sends.

The message type comes from the adapter's `send`. A message is non-empty text, or an object that the adapter accepts, such as a card from the chat adapters in `vite-hub/agent/channels`. `ChannelMessage<typeof adapter>` names it.

## Discover named Channels

Install Vite before enabling discovery:

```sh
pnpm add -D vite
```

```ts
// vite.config.ts
import { hubChannels } from "@vite-hub/channels/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubChannels()],
});
```

ViteHub discovers files below `server/channels` and files named `*.channel.ts`. A folder with an `index` module, such as `server/channels/teams/index.ts`, is one Channel named after the folder; the other files in that folder are helpers. Discovery reads each module without running it and skips modules whose default export cannot be a Channel: a function, a class, a primitive value, an array, or an object literal without `adapter`.

```ts
// server/channels/alerts.ts
import { defineChannel } from "@vite-hub/channels";

export default defineChannel({
  adapter: {
    kind: "log",
    send(text: string, options: { label: string }) {
      console.log(`[${options.label}] ${text}`);
      return { id: "message-1" };
    },
  },
});
```

Include the generated declarations in the application's TypeScript configuration:

```json
{
  "include": [".vitehub/types/**/*.d.ts", "server/**/*.ts"]
}
```

Server code can then send through the discovered Channel. The message and options are typed from its adapter:

```ts fragment
import { useChannel } from "@vite-hub/channels/server";

const [error, receipt] = await useChannel("alerts").send("Build finished.", { label: "release" });
if (error) throw error;
```

The integration writes Channel registry types to `.vitehub/types/channels.d.ts` and aliases the generated registry into Nitro builds.

## Receive webhooks

`webhook()` and `stripe()` are adapters for HTTP senders. They are plain data: `@vite-hub/agent` serves their webhooks on its Agent webhook route, which checks the signature, stores the delivery, drops repeats by delivery ID, and retries the target. The Vite plugin fails the build when a Channel imports `webhook()` or `stripe()` and the Agent Vite plugin is off.

```ts
// server/channels/stripe.ts
import { defineChannel, stripe } from "@vite-hub/channels";

export default defineChannel({
  adapter: stripe(),
  on: {
    "checkout.session.completed": event => console.log(event.id, event.data.data.object),
  },
});
```

`webhook()` needs `signature` and `secret`, such as `webhook({ signature: "bearer", secret: () => process.env.HOOK_SECRET })`. `defineChannel()` throws `CHANNELS_C0011` when one of them is missing. Use `webhook({ secret: false })` only for a route that anyone can call.

`on` maps event names to targets: a handler, or a trigger from `defineChannelTrigger()` in `@vite-hub/agent/channels`. A handler that throws or returns a failed `Result` runs again. Chat adapters, such as `slack()` and `teams()`, come from `@vite-hub/agent/channels` because they need the Chat SDK.

## Understand delivery and security limits

`send()` waits for the adapter and returns a `Result` from `@vite-hub/runtime`: `[undefined, receipt]` or `[error, undefined]`. `error.code` is `CHANNEL_INVALID_SEND` for invalid input or an adapter without `send`, `CHANNEL_DEFINITION_FAILED` when the Channel is missing or fails to load, and `CHANNEL_SEND_FAILED` when the adapter fails. `error.cause` keeps the adapter error. Check the error before using the receipt. Outbound sends are not persisted or retried, and they have no timeout. Add those behaviors before `send()` or inside the adapter when the delivery contract requires them.

Named clients share one definition load for the active registry. A failed definition load can be retried by a later `send()` call. Replacing the runtime registry invalidates that load for existing clients.

For each send, Channels tries to write `outbound.started` and either `outbound.completed` or `outbound.failed` JSON metadata under the `vitehub.channel.send` scope. Input validation and definition-loading failures return before delivery logging starts. ViteHub leaves out message text and options. Failed events include up to 2,000 characters of the thrown error message, so adapters must not put credentials or message content in errors. Adapter code can still read, transmit, or log every value it receives; keep credentials in server-only configuration and redact provider failures before throwing them.

Delivery logging is best effort. A logging failure does not change the result of a send. An inaccessible or non-string optional message `id` is left out of the receipt and log without changing delivery success.

Read the [Channels guide](https://vitehub.dev/docs/channels) for Server Env credentials, H3 and Nitro handlers, webhook targets, generated types, and delivery logs. Use the [public import reference](https://vitehub.dev/docs/reference/import-paths) when composing the owner package directly.
