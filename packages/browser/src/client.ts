import { withBrowserTimeout } from "./internal/timeout.ts"
import type {
  BrowserClaimOptions,
  BrowserClient,
  BrowserControl,
  BrowserController,
  BrowserFeatures,
  BrowserHandoffOptions,
  BrowserProviderSession,
  BrowserProviderOpenOptions,
  BrowserSession,
  BrowserSessionInfo,
  BrowserSessionRef,
  BrowserSessionState,
  CreateBrowserOptions,
} from "./types.ts"
import type { Lease, TraceEvent } from "@vite-hub/runtime"

import {
  browserLiveHandoffUnsupportedError,
  browserProviderError,
  browserSessionRefError,
  browserSessionStateError,
} from "./errors.ts"
import { browserErrorDiagnostics } from "./error-diagnostics.ts"

export type {
  BrowserClaimOptions,
  BrowserClient,
  BrowserControl,
  BrowserController,
  BrowserControllerContext,
  BrowserControllerLease,
  BrowserFeatures,
  BrowserHandoffOptions,
  BrowserIsolation,
  BrowserPolicy,
  BrowserProvider,
  BrowserProviderInfo,
  BrowserProviderOpenOptions,
  BrowserProviderSession,
  BrowserSession,
  BrowserSessionInfo,
  BrowserSessionRef,
  BrowserSessionState,
  CreateBrowserOptions,
} from "./types.ts"
export type {
  BrowserAction,
  BrowserActionInput,
  BrowserDefinition,
  BrowserDefinitionBrowser,
  BrowserDefinitionContext,
  BrowserDefinitionHandler,
  BrowserDefinitionRegistry,
  BrowserLocator,
  BrowserLocatorOptions,
  BrowserLocatorWaitOptions,
  BrowserPage,
  BrowserPageGotoOptions,
  BrowserPageSession,
  BrowserRunResult,
} from "./types.ts"

const defaultFeatures: BrowserFeatures = {
  liveHandoff: false,
}

interface HandoffRecord<TConnection> {
  audience: string
  cleanup?: Promise<void>
  expiresAt: number
  features: BrowserFeatures
  lease?: Lease
  providerSession: BrowserProviderSession<TConnection>
  publicId: string
  timer: ReturnType<typeof setTimeout>
}

function randomId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${value}`
}

function timestamp(value: Date | string | undefined): string | undefined {
  if (!value) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The provider contract permits Date or string; preserve strings and serialize Dates across realms.
  return typeof value === "string" ? value : Date.prototype.toISOString.call(value)
}

function assertAudience(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw browserErrorDiagnostics.BROWSER_R0001({ message: "[vitehub:browser] Browser handoff audience must be a non-empty string." })
  }
}

function mergedFeatures(
  provider: BrowserFeatures,
  session: BrowserProviderSession["features"],
): BrowserFeatures {
  return { ...defaultFeatures, ...provider, ...session }
}

function traceEvent(name: string, attributes: Record<string, unknown>): TraceEvent {
  return {
    attributes,
    name,
    type: "lifecycle",
  }
}

async function releaseResource<TConnection>(record: {
  lease?: Lease
  providerSession: BrowserProviderSession<TConnection>
}): Promise<void> {
  let closeError: unknown
  try {
    await record.providerSession.close()
  }
  catch (error) {
    closeError = error
  }
  try {
    await record.lease?.release()
  }
  catch (error) {
    if (closeError) {
      throw new AggregateError([closeError, error], "[vitehub:browser] Browser Session close and lease release failed.")
    }
    throw error
  }
  if (closeError) throw closeError
}

class BrowserSessionImpl<TConnection> implements BrowserSession<TConnection> {
  readonly id: string
  private claimed: boolean
  private closePromise?: Promise<void>
  private closing = false
  private controller?: string
  private attaching = false
  private detaching = false
  private pendingControllerRelease?: { release: () => Promise<void>, complete: () => Promise<void> }
  private resourceReleased = false
  private lastControllerSupportsHandoff = true
  private state: BrowserSessionState = "released"

  constructor(
    private readonly owner: BrowserClientImpl<TConnection>,
    private readonly providerSession: BrowserProviderSession<TConnection>,
    private readonly features: BrowserFeatures,
    private readonly lease: Lease | undefined,
    options: { claimed?: boolean, publicId?: string } = {},
  ) {
    this.claimed = options.claimed === true
    this.id = options.publicId || randomId("browser")
  }

  inspect(): BrowserSessionInfo {
    return {
      expiresAt: timestamp(this.providerSession.expiresAt),
      features: { ...this.features },
      id: this.id,
      provider: this.owner.provider.name,
      state: this.state,
    }
  }

  private assertState(action: string, expected: BrowserSessionState): void {
    if (this.state !== expected) throw browserSessionStateError(action, this.state)
  }

  async attach<TClient>(
    controller: BrowserController<TClient, TConnection>,
  ): Promise<BrowserControl<TClient>> {
    this.assertState("attach a controller to", "released")
    if (this.attaching || this.closing) throw browserSessionStateError("attach a controller to", "controlled")
    if (this.claimed && !controller.features.attachExistingSession) {
      throw browserLiveHandoffUnsupportedError(this.owner.provider.name, controller.name)
    }

    this.attaching = true
    let releaseController: (() => Promise<void>) | undefined
    let releaseRollback: { release: () => Promise<void>, complete: () => Promise<void> } | undefined
    let releaseAttempted = false
    try {
      const attached = await controller.attach(this.providerSession.connection, {
        provider: this.owner.provider,
        sessionId: this.id,
      })
      let emitDetach = false
      let released = false
      let releasePromise: Promise<void> | undefined
      let tracedReleasePromise: Promise<void> | undefined
      let detachCompleted = false
      const releaseControl = async (): Promise<void> => {
        if (releasePromise) return await releasePromise
        if (released) return
        this.detaching = true
        const releasing = (async () => {
          await attached.release()
          released = true
          this.detaching = false
          if (this.state === "controlled") this.state = "released"
          this.controller = undefined
        })()
        releasePromise = releasing
        try {
          await releasing
        }
        finally {
          releasePromise = undefined
        }
      }
      releaseController = async () => {
        if (tracedReleasePromise) return await tracedReleasePromise
        if (released && (!emitDetach || detachCompleted)) return
        const releasing = (async () => {
          await releaseControl()
          if (emitDetach) {
            await this.owner.emit("browser.controller.detach", this, { controller: controller.name })
            detachCompleted = true
            if (this.pendingControllerRelease === releaseRollback) this.pendingControllerRelease = undefined
          }
        })()
        tracedReleasePromise = releasing
        try {
          await releasing
        }
        finally {
          tracedReleasePromise = undefined
        }
      }
      releaseRollback = { release: releaseControl, complete: releaseController }
      this.attaching = false
      if (this.closing || this.state !== "released") {
        releaseAttempted = true
        await withBrowserTimeout(releaseControl(), () => browserProviderError("browser", "release a late browser controller"))
        throw browserSessionStateError("attach a controller to", this.state)
      }
      this.state = "controlled"
      this.controller = controller.name
      this.lastControllerSupportsHandoff = controller.features.attachExistingSession
        && attached.preservesSessionOnRelease !== false
      const control = { client: attached.client, release: releaseController }
      emitDetach = true
      await this.owner.emit("browser.controller.attach", this, { controller: controller.name })
      return control
    }
    catch (error) {
      this.attaching = false
      const errors = [error]
      if (releaseController && !releaseAttempted) {
        this.pendingControllerRelease = releaseRollback
        try {
          await releaseController()
        }
        catch (releaseError) {
          errors.push(releaseError)
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "[vitehub:browser] Browser controller attachment failed and cleanup also failed.")
      }
      throw error
    }
  }

  async handoff(options: BrowserHandoffOptions): Promise<BrowserSessionRef> {
    this.assertState("handoff", "released")
    if (this.attaching || this.closing) throw browserSessionStateError("handoff", "controlled")
    if (options?.mode !== "live") {
      throw browserErrorDiagnostics.BROWSER_R0002({ message: '[vitehub:browser] handoff({ mode }) currently requires "live".' })
    }
    assertAudience(options.audience)
    if (!this.features.liveHandoff || !this.lastControllerSupportsHandoff) {
      throw browserLiveHandoffUnsupportedError(this.owner.provider.name, this.controller)
    }

    const ref = this.owner.createHandoff({
      audience: options.audience,
      features: this.features,
      lease: this.lease,
      providerSession: this.providerSession,
      publicId: this.id,
      ttl: options.ttl,
    })
    this.state = "handed-off"
    try {
      await this.owner.emit("browser.session.handoff", this, {
        "browser.handoff.audience_bound": true,
        expiresAt: ref.expiresAt,
      })
    }
    catch (error) {
      if (this.owner.cancelHandoff(ref)) this.state = "released"
      throw error
    }
    return ref
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise
    if (this.state === "closed" && !this.pendingControllerRelease) return
    if (this.state === "handed-off") throw browserSessionStateError("close", this.state)
    if (this.state === "controlled" && !this.detaching) throw browserSessionStateError("close", this.state)
    this.closing = true
    const closing = (async () => {
      try {
        const rollback = this.pendingControllerRelease
        if (rollback) {
          // Rollback must finish while its provider connection is still available.
          await rollback.release()
        }
        if (!this.resourceReleased) {
          await releaseResource({ lease: this.lease, providerSession: this.providerSession })
          this.resourceReleased = true
        }
        this.state = "closed"
        await rollback?.complete()
      }
      finally {
        await this.owner.emit("browser.session.close", this)
      }
    })()
    this.closePromise = closing
    try {
      await closing
    }
    finally {
      this.closePromise = undefined
    }
  }

}

class BrowserClientImpl<TConnection> implements BrowserClient<TConnection> {
  readonly provider: CreateBrowserOptions<TConnection>["provider"]
  private readonly handoffs = new Map<string, HandoffRecord<TConnection>>()

  constructor(private readonly options: CreateBrowserOptions<TConnection>) {
    this.provider = options.provider
  }

  async emit(
    name: string,
    session: BrowserSessionImpl<TConnection>,
    attributes: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.trace?.(traceEvent(name, {
      ...attributes,
      "browser.provider": this.provider.name,
      "browser.session.id": session.id,
    }))
  }

  async open(options: BrowserProviderOpenOptions = {}): Promise<BrowserSession<TConnection>> {
    const idleTimeoutMs = options.idleTimeoutMs ?? this.options.policy?.idleTimeoutMs
    const lease = await this.options.leaseStore?.acquire(`browser:${this.provider.name}`, {
      ttl: idleTimeoutMs,
    })
    let providerSession: BrowserProviderSession<TConnection>
    try {
      providerSession = await this.provider.open({ ...options, idleTimeoutMs })
    }
    catch (error) {
      await lease?.release()
      throw error
    }
    const features = mergedFeatures(this.provider.features, providerSession.features)
    const session = new BrowserSessionImpl(this, providerSession, features, lease)
    try {
      await this.emit("browser.session.acquire", session)
    }
    catch (error) {
      try {
        await releaseResource({ lease, providerSession })
      }
      catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "[vitehub:browser] Browser Session tracing failed and cleanup also failed.",
        )
      }
      throw error
    }
    return session
  }

  createHandoff(input: Omit<HandoffRecord<TConnection>, "cleanup" | "expiresAt" | "timer"> & { ttl?: number }): BrowserSessionRef {
    const ttl = input.ttl ?? this.options.policy?.handoffTtl ?? 60_000
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 2_147_483_647) {
      throw browserErrorDiagnostics.BROWSER_R0003({ message: "[vitehub:browser] Browser handoff ttl must be a positive number of milliseconds no greater than 2147483647." })
    }
    const id = randomId("browser_ref")
    const expiresAt = Date.now() + ttl
    const record: HandoffRecord<TConnection> = {
      ...input,
      expiresAt,
      timer: setTimeout(() => {
        void this.expireHandoff(id, record)
      }, ttl),
    }
    if (typeof record.timer === "object" && "unref" in record.timer) record.timer.unref()
    this.handoffs.set(id, record)
    return Object.freeze({
      audience: input.audience,
      expiresAt: new Date(expiresAt).toISOString(),
      id,
    })
  }

  cancelHandoff(ref: BrowserSessionRef): boolean {
    const record = this.handoffs.get(ref.id)
    if (!record) return false
    this.handoffs.delete(ref.id)
    clearTimeout(record.timer)
    return true
  }

  async claim(ref: BrowserSessionRef, options: BrowserClaimOptions): Promise<BrowserSession<TConnection>> {
    assertAudience(options?.audience)
    const record = this.handoffs.get(ref?.id)
    if (!record) throw browserSessionRefError("unknown")
    if (record.expiresAt <= Date.now()) {
      await this.expireHandoff(ref.id, record)
      throw browserSessionRefError("expired")
    }
    this.handoffs.delete(ref.id)
    clearTimeout(record.timer)
    if (record.audience !== options.audience) {
      await releaseResource(record).catch(() => {})
      throw browserSessionRefError("audience")
    }
    const session = new BrowserSessionImpl(
      this,
      record.providerSession,
      record.features,
      record.lease,
      { claimed: true, publicId: record.publicId },
    )
    try {
      await this.emit("browser.session.claim", session, { "browser.handoff.audience_bound": true })
    }
    catch (error) {
      try {
        await releaseResource(record)
      }
      catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "[vitehub:browser] Browser Session tracing failed and cleanup also failed.",
        )
      }
      throw error
    }
    return session
  }

  private expireHandoff(id: string, record: HandoffRecord<TConnection>): Promise<void> {
    if (this.handoffs.get(id) !== record) return Promise.resolve()
    if (record.cleanup) return record.cleanup
    record.cleanup = releaseResource(record)
      .then(() => {
        if (this.handoffs.get(id) === record) this.handoffs.delete(id)
      })
      .catch(() => {
        if (this.handoffs.get(id) !== record) return
        record.timer = setTimeout(() => void this.expireHandoff(id, record), 1_000)
        if (typeof record.timer === "object" && "unref" in record.timer) record.timer.unref()
      })
      .finally(() => {
        record.cleanup = undefined
      })
    return record.cleanup
  }
}

export function createBrowser<TConnection>(options: CreateBrowserOptions<TConnection>): BrowserClient<TConnection> {
  if (!options || typeof options !== "object" || !options.provider) {
    throw browserErrorDiagnostics.BROWSER_R0004({ message: "[vitehub:browser] createBrowser() requires a provider." })
  }
  return new BrowserClientImpl(options)
}
