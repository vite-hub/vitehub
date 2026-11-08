import { useResend } from '#imports'

export async function sendLoginCode(to: string, code: string) {
  const { emails } = useResend()

  const { data, error } = await emails.send({ from: 'Login <login@example.com>', to: [to], subject: 'Your code', html: `<b>${code}</b>`, tags: [{ name: 'kind', value: 'login' }] })
  return error ? undefined : data
}

export async function notify(message: { to: string, subject: string, text: string }) {
  await useResend().emails.send({ from: 'Bot <bot@example.com>', ...message })
}
