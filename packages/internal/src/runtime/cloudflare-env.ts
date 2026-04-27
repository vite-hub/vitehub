import { AsyncLocalStorage } from "node:async_hooks"

export type CloudflareWorkerEnv = Record<string, unknown>

export interface CloudflareWorkerExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

let activeEnv: CloudflareWorkerEnv | undefined
const activeEnvStorage = new AsyncLocalStorage<CloudflareWorkerEnv | undefined>()

export function setActiveCloudflareEnv(env: CloudflareWorkerEnv | undefined): void {
  activeEnv = env
  ;(globalThis as { __env__?: CloudflareWorkerEnv }).__env__ = env
  try {
    activeEnvStorage.enterWith(env)
  }
  catch {
    // Cloudflare Workers validates Node builtins but does not implement enterWith().
    // The request-scoped wrapper still uses AsyncLocalStorage.run() where available.
  }
}

export function clearActiveCloudflareEnv(): void {
  activeEnv = undefined
  delete (globalThis as { __env__?: CloudflareWorkerEnv }).__env__
}

export function runWithActiveCloudflareEnv<T>(env: CloudflareWorkerEnv | undefined, callback: () => T): T {
  activeEnv = env
  ;(globalThis as { __env__?: CloudflareWorkerEnv }).__env__ = env
  return activeEnvStorage.run(env, callback)
}

export function getActiveCloudflareEnv(): CloudflareWorkerEnv | undefined {
  return activeEnvStorage.getStore() ?? activeEnv ?? (globalThis as { __env__?: CloudflareWorkerEnv }).__env__
}

export function getActiveCloudflareBinding<T>(name: string): T | undefined {
  return getActiveCloudflareEnv()?.[name] as T | undefined
}

interface CloudflareEnvCarrier {
  context?: { cloudflare?: { env?: CloudflareWorkerEnv }, _platform?: { cloudflare?: { env?: CloudflareWorkerEnv } } }
  env?: CloudflareWorkerEnv
  req?: { runtime?: { cloudflare?: { env?: CloudflareWorkerEnv } } }
}

export function getCloudflareEnv(event: unknown): CloudflareWorkerEnv | undefined {
  const target = event as CloudflareEnvCarrier | undefined
  return target?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || getActiveCloudflareEnv()
}

type WaitUntilFn = (promise: Promise<unknown>) => void

interface WaitUntilCarrier {
  waitUntil?: WaitUntilFn
  context?: {
    waitUntil?: WaitUntilFn
    cloudflare?: { context?: { waitUntil?: WaitUntilFn }, waitUntil?: WaitUntilFn }
    _platform?: { cloudflare?: { context?: { waitUntil?: WaitUntilFn }, waitUntil?: WaitUntilFn } }
  }
  req?: {
    waitUntil?: WaitUntilFn
    runtime?: { cloudflare?: { context?: { waitUntil?: WaitUntilFn }, waitUntil?: WaitUntilFn } }
  }
}

export function resolveWaitUntil(event: unknown): WaitUntilFn | undefined {
  const target = event as WaitUntilCarrier | undefined
  const owners = [
    target,
    target?.context,
    target?.context?.cloudflare,
    target?.context?.cloudflare?.context,
    target?.context?._platform?.cloudflare,
    target?.context?._platform?.cloudflare?.context,
    target?.req,
    target?.req?.runtime?.cloudflare,
    target?.req?.runtime?.cloudflare?.context,
  ]
  for (const owner of owners) {
    if (typeof owner?.waitUntil === "function") {
      return owner.waitUntil.bind(owner)
    }
  }
  return undefined
}

export interface CloudflareRuntimeEvent {
  context: {
    cloudflare: { context: CloudflareWorkerExecutionContext | undefined, env: CloudflareWorkerEnv }
    waitUntil?: WaitUntilFn
  }
  env: CloudflareWorkerEnv
  waitUntil?: WaitUntilFn
}

export function createCloudflareRuntimeEvent(
  env: CloudflareWorkerEnv,
  context: CloudflareWorkerExecutionContext | undefined,
): CloudflareRuntimeEvent {
  const waitUntil = typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : undefined
  return {
    context: { cloudflare: { env, context }, waitUntil },
    env,
    waitUntil,
  }
}
