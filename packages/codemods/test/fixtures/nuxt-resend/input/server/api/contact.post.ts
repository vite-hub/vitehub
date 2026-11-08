export default defineEventHandler(async (event) => {
  const { email, message } = await readBody<{ email: string, message: string }>(event)
  const config = useRuntimeConfig(event)
  if (!config.resend?.apiKey) throw createError({ statusCode: 503 })

  const resend = useResend()
  const { error } = await resend.emails.send({
    from: 'Site <hello@example.com>',
    to: 'me@example.com',
    reply_to: email,
    subject: 'Contact',
    text: message,
  })
  if (error) throw createError({ statusCode: 502, message: error.message })
  return { ok: true }
})
