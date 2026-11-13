import { email as viteHubEmail } from 'vite-hub/email'

export default defineEventHandler(async (event) => {
  const { email, message } = await readBody<{ email: string, message: string }>(event)
  const config = useRuntimeConfig(event)
  if (!config.resend?.apiKey) throw createError({ statusCode: 503 })

  const [error] = await viteHubEmail.send({
    from: 'Site <hello@example.com>',
    to: 'me@example.com',
    replyTo: email,
    subject: 'Contact',
    text: message,
  })
  if (error) throw createError({ statusCode: 502, message: error.message })
  return { ok: true }
})
