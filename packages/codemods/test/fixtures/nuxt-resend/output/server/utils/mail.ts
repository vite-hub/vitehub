import { email } from 'vite-hub/email'

export async function sendLoginCode(to: string, code: string) {
  const [error, data] = await email.send({ from: 'Login <login@example.com>', to: [to], subject: 'Your code', html: `<b>${code}</b>`, tags: [{ name: 'kind', value: 'login' }] })
  return error ? undefined : data
}

export async function notify(message: { to: string, subject: string, text: string }) {
  await email.send({ from: 'Bot <bot@example.com>', ...message })
}
