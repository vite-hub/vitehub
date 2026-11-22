# @vite-hub/webhooks decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Webhooks delivery ordering and safety; lazy operations

`claim update`, `debounce delay`, `wake replacement`, `fetch redirect: manual`, `operations` in `packages/webhooks/src/database.ts`, `packages/webhooks/src/runtime.ts`, `packages/webhooks/src/operations.ts`.

**Context:** Concurrent sends, whole-second Queue delays, Queue restarts, signed bodies, CLI listing outside Nitro.

**Decision:** Single-statement claim; round delays up; replace the wake before ack; never follow redirects; lazy runtime; user: false.

**Consequences:** No claim race, no wasted retries, no signed body to a redirect target.

## A sealed member endpoint URL opens only in its own row

in `packages/webhooks/src/sealing.ts`.

**Context:** Member endpoint URLs can hold tokens, such as a T3 relay token. A database reader must not get them, and a sealed value copied into another row must not work.

**Decision:** The URL is sealed with `VITEHUB_WEBHOOKS_KEY`, and the seal binds the endpoint row and its owner. App tests get a random key that lives until the next reset, so they need no variable.

**Consequences:** Moving a sealed value to another row or owner makes it unreadable. Changing the binding breaks every stored endpoint.

## In dev, a missing key reads or writes the project key file

in `packages/webhooks/src/vite.ts`.

**Context:** Member endpoints are sealed with `VITEHUB_WEBHOOKS_KEY`. A new key on each `vite dev` restart would make every stored endpoint unreadable.

**Decision:** In `vite dev`, a missing `VITEHUB_WEBHOOKS_KEY` reads the key file of the project, or generates it. A build never generates a key.

**Consequences:** A production build without the variable fails to seal or open endpoints. Deleting the key file loses the dev endpoints.

## The member endpoint URL guard refuses every address that is not public

`checkWebhookUrl` in `packages/webhooks/src/url-guard.ts`.

**Context:** Members choose their endpoint URLs, so a URL can point at the server's own network or a cloud metadata service.

**Decision:** The guard resolves the host and refuses the URL when any address is loopback, private, link-local, cloud metadata, or another range that no receiver uses. It includes 100.64.0.0/10 (carrier-grade NAT, where Alibaba Cloud serves metadata on 100.100.100.200), IPv4-mapped IPv6 (`::ffff:0:0/96`), and NAT64 (`64:ff9b::/96`). One private address among public ones is enough to refuse. A subdomain of an allowed host is another host. The check runs again before each attempt.

**Consequences:** Removing a range opens a server-side request forgery path. Tests use TEST-NET-3 addresses, such as 203.0.113.10, and a stubbed lookup, so they need no network.

## Member options are checked at runtime

in `packages/webhooks/src/members.ts`.

**Context:** Member endpoint options can come from a request body, so TypeScript types do not protect them.

**Decision:** The member functions check the kind of each option at runtime.

**Consequences:** Removing the checks lets a request store values of the wrong kind.

## A delivery claim takes only a pending delivery, and a stale claim expires

in `packages/webhooks/src/members.ts`, `packages/webhooks/src/runtime.ts`.

**Context:** Several servers, such as a Queue flush and a request, can try to send the same delivery. A server can stop while it sends.

**Decision:** A claim with lease `0` takes only a pending delivery, never one that another server is sending, and the loser does nothing. A `sending` claim older than the stale limit was left by a stopped server, so another wake can take it. A restarted Queue may recover its job before the interrupted claim expires, so the job replaces the wake and acknowledges, instead of throwing and spending Queue retries while the lease is active.

**Consequences:** While a delivery waits or after it is sent, the same key posts nothing. Changing the claim rules can send a delivery twice.

## A delivery that needs a fix is not retried

in `packages/webhooks/src/runtime.ts`.

**Context:** A missing variable or a missing member endpoint fails every attempt until someone fixes it.

**Decision:** These failures do not throw to the Queue, so they spend no retries. Redeliver after the fix. Failure reasons and errors never hold the URL, its query, or the secret. A redelivery sends the stored JSON text, so it has the same bytes as the last send.

**Consequences:** Throwing for these failures spends all retries before the fix. Putting the URL in a reason leaks member tokens to logs.

## A debounce waits at least until the next whole second

in `packages/webhooks/src/runtime.ts`.

**Context:** Hosted Queues take delays in whole seconds.

**Decision:** A debounced delivery wakes the Queue no earlier than the next whole second. Failures of the same Agent, Workflow, or Schedule collapse into one delivery that holds the last failure, and `x-vitehub-events` counts them. A `null` key never collapses with another send.

**Consequences:** A sub-second debounce is rounded up on every host.

## Only the config hook owns the generated registry

in `packages/webhooks/src/vite.ts`.

**Context:** The Queue plugin may read the webhook handler before the `config` hook runs, and the deployment manifest reads plugin state after the build resolves its config.

**Decision:** The `config` hook writes the registry and stores the state that the manifest reads. The `queues` contribution writes only the Queue handler file. The runtime plugin installs the webhooks when the server starts, so `sendWebhook()` works in the first request.

**Consequences:** Writing the registry from another hook can race with `config` and give a stale registry.

## A delivery is signed over the bytes it posts, rebuilt from the parsed body

`postDelivery` in `packages/webhooks/src/runtime.ts`.

**Context:** The store keeps `body` as the text of `JSON.stringify(body)` at send time. `WebhookDeliveryStore.claim` returns a `WebhookDelivery`, whose `body` is the parsed value. For text that `JSON.stringify` wrote, `JSON.stringify(JSON.parse(text))` gives the same text: key order, number forms, and string escapes all come back unchanged.

**Decision:** `postDelivery` stringifies `claim.body` once, signs that string, and posts the same string. The signature always covers the bytes sent.

**Consequences:** Carrying the stored text in the claim would change the public `WebhookDelivery` and `WebhookDeliveryStore` types. A store that rewrites `body` into other JSON text, such as a JSON column that reorders keys, still posts a matching signature, but the bytes can differ from what the send stored.
