import { AsyncLocalStorage } from "node:async_hooks"

export type CloudflareWorkerEnv = Record<string, unknown>

export interface CloudflareWorkerExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

let activeEnv: CloudflareWorkerEnv | undefined
const activeEnvStorageKey = Symbol.for("vitehub.cloudflare.env-storage")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const activeEnvStorage = (runtimeGlobal[activeEnvStorageKey] ||= new AsyncLocalStorage<{ env: CloudflareWorkerEnv | undefined }>()) as AsyncLocalStorage<{ env: CloudflareWorkerEnv | undefined }>

const globalEnvProbe = Symbol("vitehub.cloudflare.global-env-probe")

/**
 * Under the Nitro Cloudflare dev server, `cloudflare:workers` exports unenv's env proxy, which reads every key from
 * `globalThis.__env__`. Storing that proxy in `__env__` makes it read itself, and the next read overflows the stack.
 */
function readsGlobalEnv(env: CloudflareWorkerEnv): boolean {
  const scope = globalThis as { __env__?: CloudflareWorkerEnv }
  const owned = Object.hasOwn(scope, "__env__")
  const previous = scope.__env__
  scope.__env__ = { [globalEnvProbe]: true }
  try {
    return Reflect.get(env, globalEnvProbe) === true
  }
  catch {
    return false
  }
  finally {
    if (owned) scope.__env__ = previous
    else delete scope.__env__
  }
}

export function setActiveCloudflareEnv(env: CloudflareWorkerEnv | undefined): void {
  activeEnv = env
  // Keep the host's bindings in `__env__` when env is a view of `__env__` itself.
  if (!env || !readsGlobalEnv(env)) (globalThis as { __env__?: CloudflareWorkerEnv }).__env__ = env
  try {
    activeEnvStorage.enterWith({ env })
  }
  catch {
    // Cloudflare Workers validates Node builtins but does not implement enterWith().
    // The request-scoped wrapper still uses AsyncLocalStorage.run() where available.
  }
}

export function clearActiveCloudflareEnv(): void {
  setActiveCloudflareEnv(undefined)
  delete (globalThis as { __env__?: CloudflareWorkerEnv }).__env__
}

export function runWithActiveCloudflareEnv<T>(env: CloudflareWorkerEnv | undefined, callback: () => T): T {
  return activeEnvStorage.run({ env }, callback)
}

export function getActiveCloudflareEnv(): CloudflareWorkerEnv | undefined {
  const scoped = activeEnvStorage.getStore()
  return scoped ? scoped.env : activeEnv ?? (globalThis as { __env__?: CloudflareWorkerEnv }).__env__
}

/**
 * Identifies the active Cloudflare request. `runWithActiveCloudflareEnv()` creates one scope per call.
 * Without that wrapper, the scope is the env object last installed with `setActiveCloudflareEnv()`.
 * Workers reuse the host env object across requests, so the host's `globalThis.__env__` is never a scope.
 * Returns undefined outside a Cloudflare request.
 */
export function getActiveCloudflareRequestScope(): object | undefined {
  const scoped = activeEnvStorage.getStore()
  if (scoped) return scoped.env ? scoped : undefined
  return activeEnv
}

export function getActiveCloudflareBinding<T>(name: string): T | undefined {
  const env = getActiveCloudflareEnv()
  // SAFETY: The caller chooses T, and the binding name is an own property of the environment.
  return env && Object.hasOwn(env, name) ? env[name] as T : undefined
}

interface CloudflareEnvCarrier {
  context?: { cloudflare?: { env?: CloudflareWorkerEnv }, _platform?: { cloudflare?: { env?: CloudflareWorkerEnv } } }
  env?: CloudflareWorkerEnv
  node?: { req?: { runtime?: { cloudflare?: { env?: CloudflareWorkerEnv } } } }
  req?: { runtime?: { cloudflare?: { env?: CloudflareWorkerEnv } } }
}

export function getCloudflareEnv(event: unknown, options: { fallback?: boolean } = {}): CloudflareWorkerEnv | undefined {
  const target = event as CloudflareEnvCarrier | undefined
  return target?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || target?.node?.req?.runtime?.cloudflare?.env
    || (options.fallback === false ? undefined : getActiveCloudflareEnv())
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
  node?: {
    req?: {
      waitUntil?: WaitUntilFn
      runtime?: { cloudflare?: { context?: { waitUntil?: WaitUntilFn }, waitUntil?: WaitUntilFn } }
    }
  }
}

export function resolveWaitUntil(event: unknown, options: { preferHost?: boolean } = {}): WaitUntilFn | undefined {
  const target = event as WaitUntilCarrier | undefined
  const hosts = [
    target?.context,
    target?.context?.cloudflare,
    target?.context?.cloudflare?.context,
    target?.context?._platform?.cloudflare,
    target?.context?._platform?.cloudflare?.context,
    target?.req,
    target?.req?.runtime?.cloudflare,
    target?.req?.runtime?.cloudflare?.context,
    target?.node?.req,
    target?.node?.req?.runtime?.cloudflare,
    target?.node?.req?.runtime?.cloudflare?.context,
  ]
  const owners = options.preferHost ? [...hosts, target] : [target, ...hosts]
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
