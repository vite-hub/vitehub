import { email } from "vite-hub/email/server"

export default async function send(value: unknown) {
  const [error] = await email.send({
    from: "ViteHub <hello@example.com>",
    subject: "Packed workflow",
    text: "ViteHub packed workflow proof",
    to: "user@example.com",
  })
  if (error) throw error
  return value
}
