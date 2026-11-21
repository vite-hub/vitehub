// The Comments API with Send on, for send.browser.mjs: the real handler and the real Send service on an in-memory
// Database. Webhooks pairs and keeps endpoints for real, but answers each delivery as the test says, so the pill can
// show every state without posting anywhere.
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"

import { createDrizzleWebhookEndpointStore, createDrizzleWebhookStore, webhooksTables } from "../../../webhooks/src/database.ts"
import * as realWebhooks from "../../../webhooks/src/index.ts"
import { installWebhooks } from "../../../webhooks/src/runtime.ts"
import { defineComments } from "../../src/index.ts"
import { installComments } from "../../src/install.ts"
import { createCommentsHandler } from "../../src/runtime/handler.ts"
import { commentSendsTables } from "../../src/send/database.ts"
import { commentsMigration } from "../harness.ts"

import type { CommentsDatabase } from "../../src/operations-core/store.ts"
import type { CommentSendWebhooks } from "../../src/send/service.ts"

const people: Record<string, { id: string, name: string }> = { ana: { id: "ana", name: "Ana" }, bob: { id: "bob", name: "Bob" } }

export async function createSendApi() {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple([commentsMigration, ...[...commentSendsTables, ...webhooksTables].map(statement => `${statement};`)].join("\n"))
  process.env.VITEHUB_WEBHOOKS_KEY ??= btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  const db = drizzle({ client })
  installWebhooks({ webhooks: {}, store: createDrizzleWebhookStore(db), endpoints: createDrizzleWebhookEndpointStore(db) })
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  const database = drizzle({ client }) as unknown as CommentsDatabase
  const control = { fail: false, delay: 0, deliveries: 0 }
  const webhooks: CommentSendWebhooks = {
    ...realWebhooks,
    getMemberDeliveryState: async () => undefined,
    sendToMemberEndpoint: async () => {
      await new Promise(resolve => setTimeout(resolve, control.delay))
      control.deliveries++
      return [undefined, { id: `whd_${control.deliveries}`, status: control.fail ? "failed" : "sent" }]
    },
  }
  const comments = defineComments({
    identify: ({ event }) => people[/(?:^|;\s*)user=(\w+)/.exec(event["~standard"].req.headers.get("cookie") ?? "")?.[1] ?? "ana"] ?? null,
    authorize: () => true,
    send: true,
  })
  installComments(comments, { database, webhooks: async () => webhooks })
  const app = new H3().all("/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
  const page = "/"
  return {
    fetch: (request: Request) => app.fetch(request),
    control,
    comment: async (as: string, body: string) => {
      const [error, thread] = await comments.create({ page, body, author: people[as]! })
      if (error) throw error
      return thread.id
    },
    /** The agent answers: it resolves every open thread. */
    resolveAll: async () => {
      const [, threads] = await comments.list({ page, status: "open" })
      for (const thread of threads ?? []) await comments.resolve(thread.id, { by: people.ana! })
    },
    /** Fills the hour of `member` with 30 sends, so the next one is limited. */
    fillHour: async (member: string) => {
      const now = Date.now()
      for (let index = 0; index < 30; index++) {
        await client.execute({ sql: "INSERT INTO vitehub_comment_sends (id, member, subject_kind, subject_id, page, threads, key, state, sender, created_at, updated_at) VALUES (?, ?, 'page', '/', '/', '[]', ?, 'done', '{}', ?, ?)", args: [`send_fill_${index}`, member, `fill_${index}`, now - 1000 * (60 - index), now] })
      }
    },
    /** Makes every setup code too old. */
    expireCodes: async () => {
      await client.execute("UPDATE vitehub_webhook_pairings SET expires_at = 0")
    },
  }
}
