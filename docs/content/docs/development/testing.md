---
title: Testing
description: Test server routes that use KV, Blob, Database, Queue, Email, Rate Limit, Server Env, and Agent Channels, with no mocks and no provider account.
navigation.order: 34
navigation.group: Proof and recovery
icon: i-lucide-flask-conical
---

`vite-hub/test` runs your server code in Vitest against local backends. A route test calls the real route. It writes real Database rows and KV keys, and you read the emails and Queue jobs that it sent. You need no `vi.mock()` and no provider account.

## Set up a test file

Call `setupViteHubTest()` once in the test file, and `reset()` before each test. Every test then starts with empty storage.

```ts [test/signup.test.ts]
import { H3 } from 'h3'
import { beforeEach, expect, test } from 'vitest'
import { useDatabase } from 'vite-hub/database/drizzle'
import { kv } from 'vite-hub/kv'
import { setupViteHubTest } from 'vite-hub/test'

import signup from '../server/api/signup.post'

const hub = setupViteHubTest()
const app = new H3().post('/api/signup', signup)

beforeEach(async () => {
  await hub.reset()
  hub.setEnv({ MAIL_FROM: 'hello@example.com' })
})

test('signup saves the user and sends the welcome email', async () => {
  const response = await app.fetch(new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com' }),
  }))
  expect(response.status).toBe(200)

  const { db, schema } = useDatabase('default')
  expect(await db.select().from(schema.users)).toEqual([{ id: 1, email: 'ada@example.com' }])
  expect(await kv.get('signups')).toEqual([undefined, 1])
  expect(hub.emails).toMatchObject([{ to: 'ada@example.com', subject: 'Welcome' }])
  expect(hub.jobs).toMatchObject([{ queue: 'welcome', payload: { userId: 1 } }])
})
```

Run the tests with the `vitehub()` plugin and Vitest's `node` environment. Vitest reads `vite.config.ts` when the app has no `vitest.config.ts`, so `vitehub()` resolves the generated modules that your code imports, such as `#vitehub/env/server` and the Database schema.

```ts [vite.config.ts]
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', database: true, email: { driver: 'resend' }, kv: true, queue: true })],
  test: { environment: 'node' },
})
```

If you keep a separate `vitest.config.ts`, add the same `vitehub()` plugin there.

`reset()` is a plain function, so the same setup works with any runner that has a `beforeEach` hook.

## What each Primitive uses in a test

| Primitive | Backend in a test | Inspect it with |
| --- | --- | --- |
| KV | An `fs-lite` store in a temporary folder | `kv.get()`, `kv.keys()` |
| Blob | An `fs` store in a temporary folder | `blob.get()`, `blob.list()` |
| Database | In-memory SQLite with the migrations of each Definition | `useDatabase(name).db` |
| Queue | A list of the jobs that `runQueue()`, `deferQueue()`, and `getQueue()` sent. No handler runs. | `hub.jobs` |
| Email | A list of the messages that `email.send()` accepted. No provider runs. | `hub.emails` |
| Rate Limit | Memory counters, also when the host is Cloudflare. A request without a client address counts as one client. | `checkRateLimit()` |
| Server Env | The values of `hub.setEnv()`, read before `process.env` | `useServerEnv()` |

`reset()` deletes the temporary folders, closes the databases, empties both lists, and clears the `setEnv()` values. The configured drivers are not used: a test never writes to `.vitehub/data` or to a provider.

Database applies the Drizzle Kit migrations in the Definition's migrations folder, such as `server/databases/migrations/`. Run `vitehub db generate` after a schema change, as for `vite dev`. Postgres Definitions keep their own connection in tests.

To run a Queue handler, import its Definition and call the handler with a job from `hub.jobs`.

## Deliver a Channel message to an Agent

`hub.deliverChannel()` sends one webhook delivery to an Agent Channel, as the provider would. It returns the webhook response after the Agent run and its replies finish. Pass the header that the Channel checks.

```ts [test/telegram.test.ts]
import { expect, test } from 'vitest'
import { setupViteHubTest } from 'vite-hub/test'

import agent from '../server/agents/calories/agent'

const hub = setupViteHubTest()

test('a Telegram message starts a run', async () => {
  const response = await hub.deliverChannel(agent, 'telegram', {
    update_id: 1,
    message: { message_id: 1, date: 1788358000, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Ada' }, text: 'Two eggs' },
  }, { agentName: 'calories', headers: { 'x-telegram-bot-api-secret-token': 'test-secret' } })

  expect(response.status).toBe(200)
})
```

The Channel adapter still calls the provider API for replies and files, so stub `fetch` for those calls, or give the Agent a test model. Only a test that calls `deliverChannel()` loads `@vite-hub/agent`.

## API

`setupViteHubTest(options?)` turns on test mode for the process and returns the test handle.

| Option | Default | Behavior |
| --- | --- | --- |
| `root` | `process.cwd()` | The app folder that has `server/`. Database reads migrations relative to it. |

| Member | Behavior |
| --- | --- |
| `reset()` | Empties every backend and clears the `setEnv()` values. Call it in `beforeEach`. |
| `setEnv(values)` | Sets Server Env values until the next reset. `undefined` removes a value. |
| `emails` | Messages that `email.send()` accepted during the current test. |
| `jobs` | Queue jobs as `{ queue, payload, options, id }`, in send order. |
| `deliverChannel(agent, channel, body, options?)` | Sends one webhook delivery and waits for its work. `options.headers` and `options.agentName` (default `agent`) shape the request. A string or bytes body goes as is; any other body goes as JSON. |

`vite-hub/test` loads no Primitive. Each Primitive switches to its test backend only when your code calls it, so a test pays only for the features that the app uses.
