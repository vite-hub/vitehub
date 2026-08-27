const retryDelays = [1_000, 2_000, 5_000, 10_000, 15_000]
const retryable = /container is starting|currently provisioning|retry in a moment|network connection lost|not listening in the tcp address|durable object reset|code was updated|aborterror|aborted|timed out after|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object/i

export const cloudflareControlPlaneTimeout = 15_000
export const cloudflareExecTimeout = 180_000
export const cloudflareReadTimeout = 15_000
export const cloudflareStopTimeout = 10_000

export async function withCloudflareRequest<T>(operation: string, timeout: number, run: () => Promise<T>) {
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      return await withDeadline(operation, timeout, run)
    }
    catch (error) {
      const message = [error instanceof Error ? error.message : String(error), error instanceof Error && error.cause instanceof Error ? error.cause.message : ''].join('\n')
      if (attempt === retryDelays.length || !retryable.test(message))
        throw new Error(`[vitehub] Cloudflare Box ${operation} failed: ${message.trim()}`, { cause: error })
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]))
    }
  }
  throw new Error(`[vitehub] Cloudflare Box ${operation} retries exhausted.`)
}

async function withDeadline<T>(operation: string, timeout: number, run: () => Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[vitehub] Cloudflare Box ${operation} timed out after ${timeout}ms.`)), timeout)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}
