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

export interface CloudflareRuntimeEvent {
  context: {
    cloudflare: { context: CloudflareWorkerExecutionContext | undefined, env: CloudflareWorkerEnv }
    waitUntil?: (promise: Promise<unknown>) => void
  }
  env: CloudflareWorkerEnv
  waitUntil?: (promise: Promise<unknown>) => void
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
