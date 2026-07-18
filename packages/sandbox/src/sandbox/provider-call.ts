import { SandboxError } from './errors'

import type { SandboxErrorCode, SandboxOperation } from './errors'
import type { SandboxProvider } from './types/common'

type ProviderCallOptions = {
  code?: SandboxErrorCode
  operation: SandboxOperation | string
  provider: SandboxProvider
  signal?: AbortSignal
}

const wrappedNatives = new WeakMap<object, object>()

function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value
    && typeof value === 'object'
    && 'aborted' in value
    && 'reason' in value
    && typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
}

function findAbortSignal(values: readonly unknown[]): AbortSignal | undefined {
  for (const value of values) {
    if (isAbortSignal(value))
      return value
    if (!value || typeof value !== 'object' || Array.isArray(value))
      continue
    for (const candidate of Object.values(value)) {
      if (isAbortSignal(candidate))
        return candidate
    }
  }
}

export function isSandboxAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!(signal?.aborted && error === signal.reason)
    || (!!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

export function normalizeSandboxProviderError(error: unknown, options: ProviderCallOptions): unknown {
  if (error instanceof SandboxError || isSandboxAbort(error, options.signal))
    return error

  return new SandboxError({
    cause: error,
    code: options.code ?? 'SANDBOX_TRANSPORT_ERROR',
    details: { operation: options.operation, provider: options.provider },
    message: error instanceof Error ? error.message : String(error),
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function'
}

export function callSandboxProvider<T>(options: ProviderCallOptions, run: () => T): T {
  try {
    const result = run()
    if (isPromiseLike(result)) {
      return Promise.resolve(result).catch((error) => {
        throw normalizeSandboxProviderError(error, options)
      }) as T
    }
    return result
  }
  catch (error) {
    throw normalizeSandboxProviderError(error, options)
  }
}

function hasCallableMember(value: object): boolean {
  let current: object | null = value
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (key !== 'constructor' && typeof descriptor?.value === 'function')
        return true
    }
    current = Object.getPrototypeOf(current)
  }
  return false
}

function wrapResult<T>(value: T, provider: SandboxProvider): T {
  if (!value || typeof value !== 'object' || value instanceof Date || Array.isArray(value) || !hasCallableMember(value))
    return value
  return wrapSandboxProviderNative(value, provider)
}

export function wrapSandboxProviderNative<T extends object>(native: T, provider: SandboxProvider): T {
  const existing = wrappedNatives.get(native)
  if (existing)
    return existing as T

  const wrapped = new Proxy(native, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const options = {
            operation: String(property),
            provider,
            signal: findAbortSignal(args),
          }
          const result = callSandboxProvider(options, () => Reflect.apply(value, target, args))
          if (isPromiseLike(result))
            return Promise.resolve(result).then(resolved => wrapResult(resolved, provider))
          return wrapResult(result, provider)
        }
      }
      return value && typeof value === 'object' && hasCallableMember(value)
        ? wrapSandboxProviderNative(value, provider)
        : value
    },
  })
  wrappedNatives.set(native, wrapped)
  return wrapped
}
