import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function welcome(to: string) {
  const result = await resend.emails.send({ from: 'Team <team@example.com>', to, subject: 'Welcome', react: Welcome({ to }) })
  return result.data?.id
}

export async function newsletter(to: string[]) {
  return resend.batch.send(to.map(address => ({ from: 'News <news@example.com>', to: address, subject: 'News', text: 'Hi' })))
}
