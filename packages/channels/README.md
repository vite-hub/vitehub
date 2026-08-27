# @vite-hub/channels

`@vite-hub/channels` gives server code a named destination for outbound messages. An application supplies one or more connectors, then Channels selects a connector and returns the same normalized delivery result to every caller.

Most ViteHub applications should install the `vite-hub` framework distribution and use its `vite-hub/channels` imports. Install this owner package directly when you are building a library, a custom framework integration, or another focused composition.

## Install the owner package

```sh
pnpm add @vite-hub/channels
```

The package requires Node.js 24 or newer. Vite is an optional peer and is needed only for Channel Definition discovery.

## Send through an explicit Channel

Use `createChannel()` when application code already has the connector and does not need file discovery.

```ts
import { createChannel, defineChannel } from "@vite-hub/channels";

const delivered: string[] = [];

const alerts = createChannel(
  "alerts",
  defineChannel({
    connectors: {
      log: {
        send(text: string, options: { label: string }) {
          delivered.push(`[${options.label}] ${text}`);
          return { id: "message-1" };
        },
      },
    },
  }),
);

const result = await alerts.send("Build finished.", {
  connector: "log",
  label: "release",
});
```

The connector receives `Build finished.` and `{ label: "release" }`. The call adds the Channel name, selected connector, and a new delivery ID to the connector result:

```json
{
  "channel": "alerts",
  "connector": "log",
  "deliveryId": "9ece8118-5937-42f3-90a2-379e39ee151e",
  "id": "message-1"
}
```

`deliveryId` is a new UUID for every send. It identifies the attempt in logs and results; it does not provide deduplication or idempotency.

## Discover named Channel Definitions

Use the Vite integration when several call sites should load the same named Channel Definition.

```ts
// vite.config.ts
import { hubChannels } from "@vite-hub/channels/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubChannels()],
});
```

ViteHub discovers files below `server/channels` and files named `*.channel.ts`. The file below defines the `alerts` Channel:

```ts
// server/channels/alerts.ts
import { defineChannel } from "@vite-hub/channels";

export default defineChannel({
  connectors: {
    log: {
      send(text: string, options: { label: string }) {
        console.log(`[${options.label}] ${text}`);
        return { id: "message-1" };
      },
    },
  },
});
```

Server code can then send through the discovered definition:

```ts
import { useChannel } from "@vite-hub/channels/server";

const result = await useChannel("alerts").send("Build finished.", {
  connector: "log",
  label: "release",
});
```

The integration writes Channel registry types to `.vitehub/types/channels.d.ts` and aliases the generated registry into Nitro builds. It does not generate provider bindings or webhook routes.

## Understand delivery and security limits

Channels is an outbound delivery interface. It does not include Slack, Telegram, or other provider adapters. Write each connector in the application or in a separate provider package.

`send()` waits for the selected connector and returns its result. Connector failures reject the call unchanged. Channels does not persist messages, retry delivery, impose a timeout, deduplicate sends, or recover work after the process exits. Add those behaviors before `send()` or inside the connector when the delivery contract requires them.

Every send writes `started`, `completed`, or `failed` JSON metadata under the `vitehub.channel.send` scope. ViteHub omits message text and connector options from those events. Failed events include up to 2,000 characters of the thrown error message, so connectors must not put credentials or message content in errors. Connector code can still read, transmit, or log every value it receives; keep credentials in server-only configuration and redact provider failures before throwing them.

This package is separate from Agent Channels. `@vite-hub/channels` sends ordinary application messages. [`@vite-hub/agent/channels`](https://vitehub.dev/docs/agents/channels) describes where Agent Invocations come from, inbound delivery, threads, and Agent reply policy.

Read the [Channels guide](https://vitehub.dev/docs/reference/channels) for Server Env credentials, H3 and Nitro handlers, multiple connectors, generated types, and delivery logs. Use the [public import reference](https://vitehub.dev/docs/reference/import-paths) when composing the owner package directly.
