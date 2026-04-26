import { SandboxError } from '../../errors'

export function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>
}

export function buildCommandLabel(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

export function normalizeVercelExecError(command: string, args: string[], error: unknown): SandboxError {
  if (error instanceof SandboxError)
    return error

  const details = error as {
    message?: string
    response?: { status?: number, url?: string }
  }
  const commandLabel = buildCommandLabel(command, args)
  const messageParts = [`Vercel sandbox exec failed for "${commandLabel}".`]

  if (typeof details?.message === 'string' && details.message)
    messageParts.push(details.message)

  if (details?.response?.status || details?.response?.url) {
    const responseContext = [
      typeof details.response.status === 'number' ? `status ${details.response.status}` : undefined,
      typeof details.response.url === 'string' ? details.response.url : undefined,
    ].filter(Boolean).join(' at ')

    if (responseContext)
      messageParts.push(`Transport: ${responseContext}.`)
  }

  return new SandboxError(messageParts.join(' '), {
    cause: error,
    code: 'VERCEL_SANDBOX_EXEC_FAILED',
    details: { command: commandLabel },
    method: 'exec',
    provider: 'vercel',
  })
}
