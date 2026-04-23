import type { SandboxWaitForPortOptions } from '../types/common'
import { hasProtocol } from 'ufo'
import { SandboxError } from '../errors'

export function normalizeLogPattern(pattern: string | RegExp): RegExp {
  return typeof pattern === 'string'
    ? new RegExp(pattern)
    : new RegExp(pattern.source, pattern.flags.replace(/g/g, ''))
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function resolvePortProbeUrl(
  port: number,
  opts?: SandboxWaitForPortOptions,
  resolvePortUrl?: () => string,
) {
  if (opts?.hostname)
    return hasProtocol(opts.hostname, { acceptRelative: false }) ? opts.hostname : `http://${opts.hostname}:${port}`

  if (resolvePortUrl) {
    try {
      return resolvePortUrl()
    }
    catch {
      return `http://localhost:${port}`
    }
  }

  return `http://localhost:${port}`
}

export async function waitForPortProbe(
  fetcher: (url: string, init?: RequestInit) => Promise<unknown>,
  port: number,
  opts?: SandboxWaitForPortOptions,
  resolvePortUrl?: () => string,
): Promise<void> {
  const timeout = opts?.timeout ?? 30_000
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 1000)
      await fetcher(resolvePortProbeUrl(port, opts, resolvePortUrl), { signal: controller.signal })
      clearTimeout(timeoutId)
      return
    }
    catch {
      await sleep(100)
    }
  }

  throw new SandboxError(`Timeout waiting for port ${port}`, 'TIMEOUT')
}
