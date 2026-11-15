import { defineHandler, HTTPError, readBody } from "h3"
import { useServerEnv } from "vite-hub/env"
import { useDatabase } from "vite-hub/database"
import { email } from "vite-hub/email"
import { kv } from "vite-hub/kv"
import { sendQueue } from "vite-hub/queue"
import { startWorkflow } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const body = await readBody<{ email?: unknown }>(event)
  if (typeof body?.email !== "string" || !body.email.includes("@")) throw new HTTPError({ message: "Send an email address.", status: 400 })

  const { db, schema } = useDatabase("default")
  const [user] = await db.insert(schema.users).values({ email: body.email }).returning()
  if (!user) throw new HTTPError({ message: "The user was not saved.", status: 500 })

  const [countError, count] = await kv.get<number>("signups")
  if (countError) throw countError
  const [setError] = await kv.set("signups", (count ?? 0) + 1)
  if (setError) throw setError

  const [sendError] = await email.send({ from: useServerEnv().mailFrom, subject: "Welcome", text: "Thanks for signing up.", to: user.email })
  if (sendError) throw sendError

  const [queueError] = await sendQueue("welcome", { userId: user.id }, { delaySeconds: 86_400 })
  if (queueError) throw queueError

  await startWorkflow("onboarding", { userId: user.id })

  return user
})
