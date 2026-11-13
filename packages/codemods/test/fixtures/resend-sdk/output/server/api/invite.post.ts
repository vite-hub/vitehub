import { email as viteHubEmail } from 'vite-hub/email'

export default defineEventHandler(async (event) => {
  const { email } = await readBody(event)
  const [error] = await viteHubEmail.send({ from: 'Team <team@example.com>', to: email, subject: 'Invite', text: 'Join us' })
  return { sent: !error }
})
