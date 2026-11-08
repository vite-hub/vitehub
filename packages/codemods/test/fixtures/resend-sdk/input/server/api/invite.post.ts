import { Resend } from 'resend'

const client = new Resend(process.env.RESEND_API_KEY)

export default defineEventHandler(async (event) => {
  const { email } = await readBody(event)
  const { error } = await client.emails.send({ from: 'Team <team@example.com>', to: email, subject: 'Invite', text: 'Join us' })
  return { sent: !error }
})
