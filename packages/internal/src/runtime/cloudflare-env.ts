import { AsyncLocalStorage } from "node:async_hooks"

import {
  activeEnvStorageKey,
  cloudflareOwners,
  getActiveCloudflareEnv,
  getCloudflareEnv,
  getInstalledCloudflareEnv,
  getScopedCloudflareEnv,
  ownObject,
  ownValue,
  setInstalledCloudflareEnv,
} from "./cloudflare-env-lookup.ts"
import type { CloudflareWorkerEnv } from "./cloudflare-env-lookup.ts"

export { getActiveCloudflareEnv, getCloudflareEnv }
export type { CloudflareWorkerEnv }

export interface CloudflareWorkerExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

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
  setInstalledCloudflareEnv(env)
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

/**
 * Identifies the active Cloudflare request. `runWithActiveCloudflareEnv()` creates one scope per call.
 * Without that wrapper, the scope is the env object last installed with `setActiveCloudflareEnv()`.
 * Workers reuse the host env object across requests, so the host's `globalThis.__env__` is never a scope.
 * Returns undefined outside a Cloudflare request.
 */
export function getActiveCloudflareRequestScope(): object | undefined {
  const scoped = getScopedCloudflareEnv()
  if (scoped) return scoped.env ? scoped : undefined
  return getInstalledCloudflareEnv()
}

export function getActiveCloudflareBinding<T>(name: string): T | undefined {
  const env = getActiveCloudflareEnv()
  // SAFETY: The caller chooses T, and the binding name is an own property of the environment.
  return env && Object.hasOwn(env, name) ? env[name] as T : undefined
}

/**
 * Installs the Cloudflare env of a request event, so code without the event, such as a KV or Blob store, finds its
 * bindings. Nitro middleware of Cloudflare primitives call this. A Node dev runner gives the event no env, so without a
 * `fallback` the active env stays as it is.
 */
export function installCloudflareRequestEnv(event: unknown, fallback?: CloudflareWorkerEnv): void {
  const env = getCloudflareEnv(event, { fallback: false }) ?? fallback
  if (env) setActiveCloudflareEnv(env)
}

/** Return the Cloudflare Worker execution context of a request event, if the host provides one. */
export function getCloudflareExecutionContext(event: unknown): CloudflareWorkerExecutionContext | undefined {
  for (const owner of cloudflareOwners(ownObject(event))) {
    const context = ownObject(ownValue(owner, "context"))
    // SAFETY: Cloudflare hosts store the Worker ExecutionContext as the `context` of their cloudflare object.
    if (context) return context as CloudflareWorkerExecutionContext
  }
  return undefined
}

type WaitUntilFn = (promise: Promise<unknown>) => void

export function resolveWaitUntil(event: unknown, options: { preferHost?: boolean } = {}): WaitUntilFn | undefined {
  const target = ownObject(event)
  const context = ownObject(ownValue(target, "context"))
  const cloudflare = ownObject(ownValue(context, "cloudflare"))
  const cloudflareContext = ownObject(ownValue(cloudflare, "context"))
  const platform = ownObject(ownValue(context, "_platform"))
  const platformCloudflare = ownObject(ownValue(platform, "cloudflare"))
  const platformCloudflareContext = ownObject(ownValue(platformCloudflare, "context"))
  const req = ownObject(ownValue(target, "req"))
  const reqRuntime = ownObject(ownValue(req, "runtime"))
  const reqCloudflare = ownObject(ownValue(reqRuntime, "cloudflare"))
  const reqCloudflareContext = ownObject(ownValue(reqCloudflare, "context"))
  const hosts = [
    context,
    cloudflare,
    cloudflareContext,
    platformCloudflare,
    platformCloudflareContext,
    req,
    reqCloudflare,
    reqCloudflareContext,
  ]
  const owners = options.preferHost ? [...hosts, target] : [target, ...hosts]
  for (const owner of owners) {
    const waitUntil = ownValue(owner, "waitUntil")
    if (typeof waitUntil === "function") {
      return waitUntil.bind(owner)
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
