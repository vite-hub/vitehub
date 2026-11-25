import { createHmac } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { commentsTables } from "../../../packages/comments/src/tables.ts"
import { formsTables } from "../../../packages/forms/src/database.ts"
import { webhooksTables } from "../../../packages/webhooks/src/database.ts"
import { envDeclaration, expectJson, setServerEnv, type PrimitiveEntry } from "./row.ts"

const rootSecret = "nuxt-primitives-root-secret-0123456789abcdef"

function migration(statements: readonly string[]) {
  return `${statements.map(statement => `${statement};`).join("\n--> statement-breakpoint\n")}\n`
}

const authTables = [
  "CREATE TABLE `user` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `email` text NOT NULL, `email_verified` integer DEFAULT false NOT NULL, `image` text, `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
  "CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`)",
  "CREATE TABLE `session` (`id` text PRIMARY KEY NOT NULL, `expires_at` integer NOT NULL, `token` text NOT NULL, `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `updated_at` integer NOT NULL, `ip_address` text, `user_agent` text, `user_id` text NOT NULL, `active_organization_id` text, FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`)",
  "CREATE INDEX `session_userId_idx` ON `session` (`user_id`)",
  "CREATE TABLE `account` (`id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL, `provider_id` text NOT NULL, `user_id` text NOT NULL, `access_token` text, `refresh_token` text, `id_token` text, `access_token_expires_at` integer, `refresh_token_expires_at` integer, `scope` text, `password` text, `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `updated_at` integer NOT NULL, FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE INDEX `account_userId_idx` ON `account` (`user_id`)",
  "CREATE TABLE `verification` (`id` text PRIMARY KEY NOT NULL, `identifier` text NOT NULL, `value` text NOT NULL, `expires_at` integer NOT NULL, `created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL, `updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
  "CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`)",
  "CREATE TABLE `rate_limit` (`id` text PRIMARY KEY NOT NULL, `key` text NOT NULL, `count` integer NOT NULL, `last_request` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL)",
  "CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`)",
]

async function eventually(check: () => Promise<void>, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try {
      return await check()
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

async function appOrigin(fetch: (path: string) => Promise<Response>) {
  return new URL((await fetch("/")).url).origin
}

interface WebhookDelivery {
  body: string
  event: string | undefined
  signature: string | undefined
}

let webhookReceiver: Promise<{ url: string, deliveries: Map<string, WebhookDelivery> }> | undefined

function startWebhookReceiver() {
  webhookReceiver ??= new Promise((resolve, reject) => {
    const deliveries = new Map<string, WebhookDelivery>()
    const server = createServer((request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => { body += chunk })
      request.on("end", () => {
        const { key } = JSON.parse(body) as { key: string }
        deliveries.set(key, { body, event: request.headers["x-vitehub-event"] as string | undefined, signature: request.headers["x-hub-signature-256"] as string | undefined })
        response.end("ok")
      })
    })
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => resolve({ deliveries, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook` }))
  })
  return webhookReceiver
}

const webhookSecret = "nuxt-primitives-webhook-secret"

export const access: PrimitiveEntry[] = [
  {
    id: "env",
    packages: ["@vite-hub/env"],
    vitehub: () => ({
      env: {
        public: {
          primitiveApp: envDeclaration(`env({ default: "Nuxt primitives", mode: "build" })`),
        },
        server: {
          primitiveGreeting: envDeclaration(`env({ source: env.source("PRIMITIVE_GREETING") })`),
          primitiveToken: envDeclaration(`env({ secret: true, source: env.source("PRIMITIVE_TOKEN") })`),
        },
      },
    }),
    files: {
      "server/api/primitives/env.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { usePublicEnv, useServerEnv } from "vite-hub/env"

        export default defineEventHandler((event) => {
          const { primitiveGreeting, primitiveToken } = useServerEnv(event)
          return { app: usePublicEnv().primitiveApp, greeting: primitiveGreeting, token: primitiveToken.unseal() }
        })
      `,
    },
    prepare: context => setServerEnv(context, { PRIMITIVE_GREETING: `hello from ${context.mode}`, PRIMITIVE_TOKEN: `token of ${context.mode}` }),
    async probe({ fetch, mode }) {
      await expectJson(await fetch("/api/primitives/env"), { app: "Nuxt primitives", greeting: `hello from ${mode}`, token: `token of ${mode}` })
    },
  },
  {
    id: "email",
    packages: ["@vite-hub/email", "@vite-hub/kv"],
    vitehub: () => ({ email: { driver: "./server/primitive-email-driver.ts", remote: true }, kv: true }),
    files: {
      "server/primitive-email-driver.ts": `
        import type { EmailDriver } from "vite-hub/email"
        import { kv } from "vite-hub/kv"

        export default function primitiveEmailDriver(): EmailDriver {
          return {
            name: "primitive-capture",
            async send(message) {
              const id = crypto.randomUUID()
              const [error] = await kv.set(\`primitives:email:\${id}\`, { subject: message.subject, text: message.text, to: message.to })
              if (error) throw error
              return [undefined, { at: new Date(), driver: "primitive-capture", id }]
            },
          }
        }
      `,
      "server/emails/primitive-welcome.md": [
        "---",
        "subject: Welcome, {{ data.name }}",
        "---",
        "",
        "# Welcome {{ data.name }}",
        "",
        "Your workspace is ready.",
        "",
      ].join("\n"),
      "server/api/primitives/email.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { email } from "vite-hub/email"
        import { kv } from "vite-hub/kv"

        export default defineEventHandler(async (event) => {
          const name = String(getQuery(event).name)
          const [error, sent] = await email.send({ data: { name }, from: "app@example.com", template: "primitive-welcome", to: "ada@example.com" })
          if (error) throw error
          const [readError, captured] = await kv.get(\`primitives:email:\${sent.id}\`)
          if (readError) throw readError
          const message = captured as { subject?: string, text?: string, to?: unknown } | null
          return {
            canSend: email.canSend,
            driver: sent.driver,
            subject: message?.subject ?? null,
            text: Boolean(message?.text?.includes(\`Welcome \${name}\`) && message.text.includes("Your workspace is ready.")),
            to: JSON.stringify(message?.to ?? null).includes("ada@example.com"),
          }
        })
      `,
    },
    async probe({ fetch, mode }) {
      const name = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/email?name=${name}`, { method: "POST" }), {
        canSend: true,
        driver: "primitive-capture",
        subject: `Welcome, ${name}`,
        text: true,
        to: true,
      })
    },
  },
  {
    id: "forms",
    packages: ["@vite-hub/forms", "@vite-hub/database"],
    dependencies: { valibot: "1.5.0" },
    files: {
      "server/forms/primitive-contact.ts": `
        import * as v from "valibot"
        import { defineForm } from "vite-hub/forms"

        export default defineForm({
          schema: v.object({
            email: v.pipe(v.string(), v.email("Enter a valid email.")),
            message: v.pipe(v.string(), v.trim(), v.minLength(1)),
          }),
        })
      `,
      "server/api/primitives/forms.get.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { useDatabase } from "vite-hub/database"
        import { createDrizzleFormsStore } from "vite-hub/forms/database"

        export default defineEventHandler(async (event) => {
          const submission = await createDrizzleFormsStore(useDatabase().db).get(String(getQuery(event).id))
          return submission ? { data: submission.data, form: submission.form, status: submission.status } : null
        })
      `,
      "server/databases/default/migrations/20261125000100_primitive_forms/migration.sql": migration(formsTables),
    },
    async probe({ fetch, mode }) {
      const origin = await appOrigin(fetch)
      const post = (body: unknown) => fetch("/_vitehub/forms/primitive-contact", { body: JSON.stringify(body), headers: { "content-type": "application/json", origin }, method: "POST" })
      const invalid = await post({ email: "not an email", message: "hi" })
      const invalidBody = await invalid.text()
      if (invalid.status !== 400 || !invalidBody.includes("Enter a valid email.")) throw new Error(`An invalid submission answered ${invalid.status}: ${invalidBody.slice(0, 2000)}`)
      const message = `message from ${mode}`
      const sent = await post({ email: "ada@example.com", message: `  ${message}  ` })
      const sentBody = await sent.text()
      if (sent.status !== 201) throw new Error(`A valid submission answered ${sent.status}: ${sentBody.slice(0, 2000)}`)
      const { id } = JSON.parse(sentBody) as { id: string }
      await expectJson(await fetch(`/api/primitives/forms?id=${id}`), { data: { email: "ada@example.com", message }, form: "primitive-contact", status: "open" })
    },
  },
  {
    id: "webhooks",
    packages: ["@vite-hub/webhooks", "@vite-hub/queue", "@vite-hub/database"],
    vitehub: () => ({ queue: true }),
    files: {
      "server/webhooks/primitive-hook.ts": `
        import { defineWebhook } from "vite-hub/webhooks"

        export default defineWebhook({ secret: "PRIMITIVE_WEBHOOK_SECRET", url: "PRIMITIVE_WEBHOOK_URL" })
      `,
      "server/api/primitives/webhooks.post.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { sendWebhook } from "vite-hub/webhooks"

        export default defineEventHandler(async (event) => {
          const key = String(getQuery(event).key)
          const [error, delivery] = await sendWebhook("primitive-hook", { key }, { event: "primitives.sent", key })
          if (error) throw error
          return { status: delivery.status }
        })
      `,
      "server/databases/default/migrations/20261125000200_primitive_webhooks/migration.sql": migration(webhooksTables),
    },
    async prepare(context) {
      const { url } = await startWebhookReceiver()
      await setServerEnv(context, { PRIMITIVE_WEBHOOK_SECRET: webhookSecret, PRIMITIVE_WEBHOOK_URL: url })
    },
    async probe({ fetch, mode }) {
      const { deliveries } = await startWebhookReceiver()
      const key = `${mode}-${crypto.randomUUID()}`
      await expectJson(await fetch(`/api/primitives/webhooks?key=${key}`, { method: "POST" }), { status: "pending" })
      await eventually(async () => {
        const delivery = deliveries.get(key)
        if (!delivery) throw new Error(`The receiver got no delivery for ${key}.`)
        const signature = `sha256=${createHmac("sha256", webhookSecret).update(delivery.body).digest("hex")}`
        if (delivery.body !== JSON.stringify({ key })) throw new Error(`The receiver got the body ${delivery.body}.`)
        if (delivery.event !== "primitives.sent" || delivery.signature !== signature) throw new Error(`The receiver got the event ${delivery.event} and the signature ${delivery.signature}, expected ${signature}.`)
      })
    },
  },
  {
    id: "auth",
    packages: ["@vite-hub/auth", "@vite-hub/database"],
    files: {
      "server/auth.ts": `
        import { defineAuth } from "vite-hub/auth"
        import { authDatabase } from "vite-hub/auth/database"

        export default defineAuth({
          appName: "Nuxt primitives",
          database: authDatabase(),
          emailAndPassword: { enabled: true },
        })
      `,
      "server/api/primitives/auth-me.get.ts": `
        import { defineEventHandler } from "nitro/h3"
        import { requireAuth } from "vite-hub/auth/server"

        export default defineEventHandler(async (event) => {
          const { user } = await requireAuth(event)
          return { email: user.email, name: user.name }
        })
      `,
      "server/databases/default/migrations/20261125000300_primitive_auth/migration.sql": migration(authTables),
    },
    prepare: context => setServerEnv(context, { VITEHUB_SECRET: rootSecret }),
    async probe({ fetch, mode }) {
      const origin = await appOrigin(fetch)
      const email = `${mode}-${crypto.randomUUID()}@example.com`
      const signedOut = await fetch("/api/primitives/auth-me")
      if (signedOut.status !== 401) throw new Error(`A request without a session answered ${signedOut.status}: ${(await signedOut.text()).slice(0, 2000)}`)
      const signUp = await fetch("/api/auth/sign-up/email", {
        body: JSON.stringify({ email, name: "Ada Lovelace", password: "correct-horse-battery-staple" }),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      })
      const signUpBody = await signUp.text()
      if (!signUp.ok) throw new Error(`Sign-up answered ${signUp.status}: ${signUpBody.slice(0, 2000)}`)
      const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      if (!cookie.includes("session_token=")) throw new Error(`Sign-up set no session cookie: ${signUp.headers.getSetCookie().join(" | ")}`)
      const session = await fetch("/api/auth/get-session", { headers: { cookie } })
      const sessionBody = await session.text()
      if (!session.ok || (JSON.parse(sessionBody) as { user?: { email?: string } } | null)?.user?.email !== email) throw new Error(`get-session answered ${session.status}: ${sessionBody.slice(0, 2000)}`)
      await expectJson(await fetch("/api/primitives/auth-me", { headers: { cookie } }), { email, name: "Ada Lovelace" })
    },
  },
  {
    id: "comments",
    packages: ["@vite-hub/comments", "@vite-hub/database"],
    files: {
      "server/comments.ts": `
        import { defineComments } from "vite-hub/comments"

        export const comments = defineComments({ authorize: () => true })
      `,
      "server/api/primitives/comments.get.ts": `
        import { defineEventHandler, getQuery } from "nitro/h3"
        import { comments } from "../../comments"

        export default defineEventHandler(async (event) => {
          const [error, threads] = await comments.list({ page: String(getQuery(event).page) })
          if (error) throw error
          return { threads: threads.map(thread => ({ author: thread.messages[0]?.author.name, body: thread.messages[0]?.body, status: thread.status })) }
        })
      `,
      "server/databases/default/migrations/20261125000400_primitive_comments/migration.sql": migration(commentsTables),
    },
    async probe({ fetch, mode }) {
      const origin = await appOrigin(fetch)
      const page = `/primitives/${mode}-${crypto.randomUUID()}`
      const body = `comment from ${mode}`
      const created = await fetch("/_vitehub/comments/threads", {
        body: JSON.stringify({ anchor: { kind: "page" }, body, page }),
        headers: { "content-type": "application/json", origin, "x-vitehub-comments-guest-id": "ada", "x-vitehub-comments-guest-name": "Ada" },
        method: "POST",
      })
      const createdBody = await created.text()
      if (!created.ok) throw new Error(`Creating a thread answered ${created.status}: ${createdBody.slice(0, 2000)}`)
      await expectJson(await fetch(`/api/primitives/comments?page=${encodeURIComponent(page)}`), { threads: [{ author: "Ada", body, status: "open" }] })
    },
  },
]
