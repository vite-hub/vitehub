import { defineEventHandler } from "nitro/h3"

function send(email: { to: string }) {
  return email.to
}

export default defineEventHandler(() => {
  const kv = new Map<string, string>()
  return send({ to: kv.get("to") ?? "" })
})
