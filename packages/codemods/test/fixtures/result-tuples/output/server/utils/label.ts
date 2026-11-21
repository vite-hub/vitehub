import { ask, askWithModel, typesafe } from 'vite-hub/gateways'

export const gateway = typesafe()

const questions = { recurring: ask.if('Is it a recurring payment?') }

export async function label(transaction: string) {
  const [answersError, answers] = await gateway.ask(transaction, questions)
  if (answersError) throw answersError
  const [error2] = await askWithModel(model).ask(transaction, questions)
  if (error2) throw error2
  const [error, checked] = await typesafe().ask(transaction, questions)
  return { answers, error, checked }
}

export async function notes(input: { id: string }) {
  const response = await runSandboxTask('release-notes', input)
  if (!response.ok) return null
  return await response.json()
}
