import { Cause, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import {
  cloudflareOperationEffect,
  cloudflareSandboxExecutionEffect,
  runCloudflareOperation,
  runCloudflareSandboxExecution,
} from '../src/internal/shared/cloudflare-attempt'
import { CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS } from '../src/internal/shared/cloudflare-retry'
import { SandboxError } from '../src/sandbox/errors'

const testClock = TestClock.layer({ warningDelay: '1 minute' })

function testError(message: string) {
  return new SandboxError(message, {
    code: 'SANDBOX_TRANSPORT_ERROR',
    provider: 'cloudflare',
  })
}

const mapError = (error: unknown) => error instanceof SandboxError ? error : testError(String(error))
const isRetriable = (error: SandboxError) => /container is starting/i.test(error.message)

describe('Cloudflare attempt policy', () => {
  it('uses the exact retry delays without real time', async () => {
    let attempts = 0
    const retriable = testError('container is starting')
    const operation = cloudflareOperationEffect({
      isRetriable,
      mapError,
      operation: 'exec',
      run: async () => {
        attempts += 1
        if (attempts <= CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length) throw retriable
        return 'ready'
      },
      timeout: 60_000,
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(operation)
      yield* Effect.yieldNow
      expect(attempts).toBe(1)

      for (const [index, delay] of CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.entries()) {
        yield* TestClock.adjust(delay - 1)
        expect(attempts).toBe(index + 1)
        yield* TestClock.adjust(1)
        expect(attempts).toBe(index + 2)
      }

      expect(yield* Fiber.join(fiber)).toBe('ready')
    }).pipe(Effect.provide(testClock))

    await Effect.runPromise(program)
  })

  it('applies a fresh deadline to every retry attempt', async () => {
    let attempts = 0
    const operation = cloudflareOperationEffect({
      isRetriable,
      mapError,
      operation: 'readFile',
      run: () => {
        attempts += 1
        return new Promise<never>(() => {})
      },
      timeout: 250,
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(operation))
      for (let attempt = 0; attempt <= CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length; attempt += 1) {
        yield* TestClock.adjust(250)
        if (attempt < CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length)
          yield* TestClock.adjust(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[attempt]!)
      }

      const exit = yield* Fiber.join(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason)
        expect(failure?.error.cause).toMatchObject({
          code: 'TIMEOUT',
          details: { operation: 'readFile', timeout: 250 },
          provider: 'cloudflare',
        })
      }
      expect(attempts).toBe(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS.length + 1)
    }).pipe(Effect.provide(testClock))

    await Effect.runPromise(program)
  })

  it('stops each acquired sandbox before retrying', async () => {
    let acquisitions = 0
    const events: string[] = []
    const retriable = testError('container is starting')
    let resolveFirstRelease!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      resolveFirstRelease = resolve
    })
    const execution = cloudflareSandboxExecutionEffect({
      acquire: async () => {
        const id = ++acquisitions
        events.push(`acquire:${id}`)
        return { id }
      },
      isRetriable,
      mapError,
      release: async ({ id }) => {
        events.push(`release:${id}`)
        if (id === 1) resolveFirstRelease()
      },
      use: async ({ id }) => {
        events.push(`use:${id}`)
        if (id === 1) throw retriable
        return 'done'
      },
    })

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(execution)
      yield* Effect.promise(() => firstRelease)
      expect(events).toEqual(['acquire:1', 'use:1', 'release:1'])
      yield* TestClock.adjust(CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS[0]!)
      expect(yield* Fiber.join(fiber)).toBe('done')
      expect(events).toEqual([
        'acquire:1',
        'use:1',
        'release:1',
        'acquire:2',
        'use:2',
        'release:2',
      ])
    }).pipe(Effect.provide(testClock))

    await Effect.runPromise(program)
  })

  it('preserves execution and cleanup failures in order without retrying', async () => {
    const executionError = testError('container is starting')
    const cleanupError = testError('destroy failed')
    let acquisitions = 0

    const result = runCloudflareSandboxExecution({
      acquire: async () => {
        acquisitions += 1
        return {}
      },
      isRetriable,
      mapError,
      release: async () => {
        throw cleanupError
      },
      use: async () => {
        throw executionError
      },
    })

    await expect(result).rejects.toEqual(expect.objectContaining({
      errors: [executionError, cleanupError],
      message: 'Cloudflare sandbox execution failed and cleanup also failed.',
    }))
    expect(acquisitions).toBe(1)
  })

  it('rejects with the original Sandbox error rather than FiberFailure', async () => {
    const error = testError('permission denied')
    await expect(runCloudflareOperation({
      isRetriable,
      mapError,
      operation: 'writeFile',
      run: async () => {
        throw error
      },
      timeout: 1_000,
    })).rejects.toBe(error)
  })
})
