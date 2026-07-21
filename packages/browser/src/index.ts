import type {
  BrowserClaimOptions,
  BrowserClient,
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
import type { Lease, MaybePromise, TraceEvent } from "@vite-hub/runtime"

import {
  BrowserLiveHandoffUnsupportedError,
  BrowserSessionRefError,
  BrowserSessionStateError,
} from "./errors.ts"

export {
  BrowserLiveHandoffUnsupportedError,
  BrowserProviderError,
  BrowserSessionRefError,
  BrowserSessionStateError,
} from "./errors.ts"
export type {
  BrowserClaimOptions,
  BrowserClient,
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

const defaultFeatures: BrowserFeatures = {
  liveHandoff: false,
}

interface HandoffRecord<TConnection> {
  audience: string
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
  return value instanceof Date ? value.toISOString() : value
}

function assertAudience(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("[vitehub:browser] Browser handoff audience must be a non-empty string.")
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
  private controller?: string
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
    if (this.state !== expected) throw new BrowserSessionStateError(action, this.state)
  }

  async use<TClient, TResult>(
    controller: BrowserController<TClient, TConnection>,
    run: (client: TClient) => MaybePromise<TResult>,
  ): Promise<TResult> {
    this.assertState("attach a controller to", "released")
    if (this.claimed && !controller.features.attachExistingSession) {
      throw new BrowserLiveHandoffUnsupportedError(this.owner.provider.name, controller.name)
    }

    this.state = "controlled"
    this.controller = controller.name
    let attached: Awaited<ReturnType<typeof controller.attach>> | undefined
    try {
      attached = await controller.attach(this.providerSession.connection, {
        provider: this.owner.provider,
        sessionId: this.id,
      })
      this.lastControllerSupportsHandoff = controller.features.attachExistingSession
        && attached.preservesSessionOnRelease !== false
      await this.owner.emit("browser.controller.attach", this, { controller: controller.name })
      return await run(attached.client)
    }
    finally {
      try {
        await attached?.release()
      }
      finally {
        if (this.state === "controlled") this.state = "released"
        this.controller = undefined
        await this.owner.emit("browser.controller.detach", this, { controller: controller.name })
      }
    }
  }

  async handoff(options: BrowserHandoffOptions): Promise<BrowserSessionRef> {
    this.assertState("handoff", "released")
    if (options?.mode !== "live") {
      throw new TypeError('[vitehub:browser] handoff({ mode }) currently requires "live".')
    }
    assertAudience(options.audience)
    if (!this.features.liveHandoff || !this.lastControllerSupportsHandoff) {
      throw new BrowserLiveHandoffUnsupportedError(this.owner.provider.name, this.controller)
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
    await this.owner.emit("browser.session.handoff", this, {
      "browser.handoff.audience_bound": true,
      expiresAt: ref.expiresAt,
    })
    return ref
  }

  async close(): Promise<void> {
    if (this.state === "closed") return
    if (this.state === "handed-off") throw new BrowserSessionStateError("close", this.state)
    if (this.state === "controlled") throw new BrowserSessionStateError("close", this.state)
    this.state = "closed"
    try {
      await releaseResource({ lease: this.lease, providerSession: this.providerSession })
    }
    finally {
      await this.owner.emit("browser.session.close", this)
    }
  }

  canAutoClose(): boolean {
    return this.state !== "closed" && this.state !== "handed-off"
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
    await this.emit("browser.session.acquire", session)
    return session
  }

  async withSession<TResult>(
    run: (session: BrowserSession<TConnection>) => MaybePromise<TResult>,
    options: BrowserProviderOpenOptions = {},
  ): Promise<TResult> {
    const session = await this.open(options) as BrowserSessionImpl<TConnection>
    try {
      return await run(session)
    }
    finally {
      if (session.canAutoClose()) await session.close()
    }
  }

  createHandoff(input: Omit<HandoffRecord<TConnection>, "expiresAt" | "timer"> & { ttl?: number }): BrowserSessionRef {
    const ttl = input.ttl ?? this.options.policy?.handoffTtl ?? 60_000
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new TypeError("[vitehub:browser] Browser handoff ttl must be a positive number of milliseconds.")
    }
    const id = randomId("browser_ref")
    const expiresAt = Date.now() + ttl
    const record: HandoffRecord<TConnection> = {
      ...input,
      expiresAt,
      timer: setTimeout(() => {
        const current = this.handoffs.get(id)
        if (current !== record) return
        this.handoffs.delete(id)
        void releaseResource(current).catch(() => {})
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

  async claim(ref: BrowserSessionRef, options: BrowserClaimOptions): Promise<BrowserSession<TConnection>> {
    assertAudience(options?.audience)
    const record = this.handoffs.get(ref?.id)
    if (!record) throw new BrowserSessionRefError("unknown")
    this.handoffs.delete(ref.id)
    clearTimeout(record.timer)
    if (record.expiresAt <= Date.now()) {
      await releaseResource(record).catch(() => {})
      throw new BrowserSessionRefError("expired")
    }
    if (record.audience !== options.audience) {
      await releaseResource(record).catch(() => {})
      throw new BrowserSessionRefError("audience")
    }
    const session = new BrowserSessionImpl(
      this,
      record.providerSession,
      record.features,
      record.lease,
      { claimed: true, publicId: record.publicId },
    )
    await this.emit("browser.session.claim", session, { "browser.handoff.audience_bound": true })
    return session
  }
}

export function createBrowser<TConnection>(options: CreateBrowserOptions<TConnection>): BrowserClient<TConnection> {
  if (!options || typeof options !== "object" || !options.provider) {
    throw new TypeError("[vitehub:browser] createBrowser() requires a provider.")
  }
  return new BrowserClientImpl(options)
}
