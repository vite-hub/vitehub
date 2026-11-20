// The Comments API with Send on, for send.browser.mjs: the real handler and the real Send service on an in-memory
// Database. Webhooks is a stand-in that keeps endpoints in memory and answers each delivery as the test says, so the
// pill can show every state without posting anywhere. The URL guard is the real one.
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"

import { checkWebhookUrl } from "../../../webhooks/src/url-guard.ts"
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
  await client.executeMultiple([commentsMigration, ...commentSendsTables.map(statement => `${statement};`)].join("\n"))
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  const database = drizzle({ client }) as unknown as CommentsDatabase
  const endpoints = new Map<string, { id: string, kind: "url" | "inbox", agent: string | null, host: string | null, disabledAt: number | null }>()
  const control = { fail: false, delay: 0, deliveries: 0 }
  const webhooks: CommentSendWebhooks = {
    createMemberEndpoint: async (options) => {
      const endpoint = { id: `whe_${options.owner}`, kind: options.kind, agent: options.agent ?? null, host: options.kind === "url" ? new URL(options.url).host : null, disabledAt: null }
      endpoints.set(options.owner, endpoint)
      return [undefined, endpoint]
    },
    getMemberEndpoint: async owner => [undefined, endpoints.get(owner) ?? null],
    sendToMemberEndpoint: async () => {
      await new Promise(resolve => setTimeout(resolve, control.delay))
      control.deliveries++
      return [undefined, { id: `whd_${control.deliveries}`, status: control.fail ? "failed" : "sent" }]
    },
    // The real guard. The T3 relay resolves in public DNS; any other host fails before a lookup.
    checkWebhookUrl,
    sealWebhooksText: async (label, text) => [undefined, btoa(JSON.stringify([label, text]))],
    unsealWebhooksText: async (_label, sealed) => [undefined, JSON.parse(atob(sealed))[1]],
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
