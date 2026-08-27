import browserRegistry from "#vitehub/browser/registry"
import runtimeConfig from "#vitehub/browser/runtime"

import {
  browserDefinitionNotFoundError,
  browserProviderError,
  browserRuntimeNotConfiguredError,
  toBrowserError,
} from "./errors.ts"
import { createBrowser } from "./client.ts"
import { cdp } from "./controllers/cdp.ts"
import { runBrowserAction, runBrowserContent } from "./actions.ts"
import { attachCDPPage } from "./internal/cdp-page.ts"
import { importBrowserOptionalPeer } from "./internal/optional-peer.ts"
import { createCloudflareBrowser } from "./internal/cloudflare-provider.ts"

import type { CloudflarePlaywrightDriver } from "./internal/cloudflare-provider.ts"

import type {
  BrowserAction,
  BrowserActionInput,
  BrowserClient,
  BrowserControl,
  BrowserController,
  BrowserDefinition,
  BrowserDefinitionBrowser,
  BrowserDefinitionHandler,
  BrowserPage,
  BrowserPageSession,
  BrowserProviderOpenOptions,
  BrowserRunResult,
  BrowserSession,
} from "./types.ts"
import type { CDPClient } from "./controllers/cdp.ts"
import type { PlaywrightBrowserConnection } from "./internal/connections.ts"
import type {
  BrowserDefinitionInputArgs,
  BrowserDefinitionName,
  BrowserDefinitionResult,
  BrowserRegistryDefinition,
} from "./registry-types.ts"

const CONTROLLER_ATTACH_TIMEOUT_MS = 30_000

async function boundedCleanup(cleanup: Promise<void>, operation = "close the browser after setup failure"): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(browserProviderError("cdp", operation))
        }, CONTROLLER_ATTACH_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

async function attachController<TConnection>(
  providerSession: BrowserSession<TConnection>,
  controller: BrowserController<CDPClient, TConnection>,
): Promise<BrowserControl<CDPClient>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const attachment = providerSession.attach(controller)
  try {
    return await Promise.race([
      attachment,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(browserProviderError("cdp", "attach the browser controller"))
        }, CONTROLLER_ATTACH_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

function closeErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

class ManagedBrowserPageSession<TConnection> implements BrowserPageSession {
  readonly id
  readonly page
  private closed = false
  private closePromise?: Promise<void>

  constructor(
    private readonly providerSession: BrowserSession<TConnection>,
    private readonly control: BrowserControl<CDPClient>,
    page: BrowserPage,
  ) {
    this.id = providerSession.id
    this.page = page
  }

  inspect() {
    return this.providerSession.inspect()
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise
    if (this.closed) return
    const closing = (async () => {
      const errors: unknown[] = []
      try {
        await boundedCleanup(this.control.release(), "release the browser controller during session cleanup")
      }
      catch (error) {
        errors.push(error)
      }
      try {
        await boundedCleanup(this.providerSession.close(), "close the browser provider during session cleanup")
      }
      catch (error) {
        errors.push(error)
      }
      if (errors.length === 0) this.closed = true
      closeErrors(errors, "[vitehub:browser] Browser Session controller and provider cleanup failed.")
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

interface BrowserDefinitionRuntimeOptions {
  client?: BrowserClient<PlaywrightBrowserConnection>
  controller?: BrowserController<CDPClient, PlaywrightBrowserConnection>
}

class BrowserDefinitionBrowserImpl implements BrowserDefinitionBrowser {
  private readonly sessions: Array<ManagedBrowserPageSession<PlaywrightBrowserConnection>> = []

  constructor(private readonly options: BrowserDefinitionRuntimeOptions) {}

  async content(input: BrowserActionInput): Promise<string> {
    const [error, content] = await runBrowserContent(input)
    if (error) throw error
    return content
  }

  async run(action: BrowserAction, input: BrowserActionInput): Promise<Response> {
    const [error, response] = await runBrowserAction(action, input)
    if (error) throw error
    return response
  }

  async open(options?: BrowserProviderOpenOptions): Promise<BrowserPageSession> {
    const providerSession = await (this.options.client ?? resolveConfiguredClient()).open(options)
    let control: BrowserControl<CDPClient> | undefined
    try {
      control = await attachController(providerSession, this.options.controller ?? cdp())
      const { page } = await attachCDPPage(control.client)
      const session = new ManagedBrowserPageSession(providerSession, control, page)
      this.sessions.push(session)
      return session
    }
    catch (error) {
      const errors = [error]
      if (control) {
        try {
          await boundedCleanup(control.release(), "release the browser controller after setup failure")
        }
        catch (releaseError) {
          errors.push(releaseError)
        }
      }
      try {
        await boundedCleanup(providerSession.close())
      }
      catch (closeError) {
        errors.push(closeError)
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "[vitehub:browser] Browser Session setup failed and provider cleanup also failed.")
      }
      throw error
    }
  }

  async close(): Promise<void> {
    const errors: unknown[] = []
    for (const session of [...this.sessions].reverse()) {
      try {
        await session.close()
      }
      catch (error) {
        errors.push(error)
      }
    }
    closeErrors(errors, "[vitehub:browser] One or more Browser Sessions failed to close.")
  }
}

let configuredClient: BrowserClient<PlaywrightBrowserConnection> | undefined

function resolveConfiguredClient(): BrowserClient<PlaywrightBrowserConnection> {
  if (configuredClient) return configuredClient
  if (runtimeConfig.provider !== "cloudflare") throw browserRuntimeNotConfiguredError()
  configuredClient = createBrowser({
    provider: createCloudflareBrowser(
      {
        binding: runtimeConfig.binding,
        engine: runtimeConfig.engine,
      },
      () => importBrowserOptionalPeer<CloudflarePlaywrightDriver>("@cloudflare/playwright"),
    ),
  })
  return configuredClient
}

function isBrowserDefinition(value: unknown): value is BrowserDefinition {
  return !!value && typeof value === "object" && typeof (value as BrowserDefinition).run === "function"
}

async function resolveBrowserDefinition(name: string): Promise<BrowserDefinition> {
  const entry = browserRegistry[name]
  if (!entry) throw browserDefinitionNotFoundError(name)
  const loaded = typeof entry === "function" ? await entry() : entry
  const definition = "default" in loaded && loaded.default ? loaded.default : loaded
  if (!isBrowserDefinition(definition)) {
    throw new TypeError(`[vitehub:browser] Browser Definition ${JSON.stringify(name)} must default-export defineBrowser().`)
  }
  return definition
}

export function defineBrowser<TInput = unknown, TResult = unknown>(
  run: BrowserDefinitionHandler<TInput, TResult>,
): BrowserDefinition<TInput, TResult> {
  if (typeof run !== "function") {
    throw new TypeError("[vitehub:browser] defineBrowser() requires a Browser Definition handler.")
  }
  return { run }
}

export async function executeBrowserDefinition<TInput, TResult>(
  definition: BrowserDefinition<TInput, TResult>,
  input: TInput,
  options: BrowserDefinitionRuntimeOptions = {},
): Promise<TResult> {
  const browser = new BrowserDefinitionBrowserImpl(options)
  let result: TResult
  try {
    result = await definition.run(input, { browser })
  }
  catch (error) {
    try {
      await browser.close()
    }
    catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "[vitehub:browser] Browser Definition failed and session cleanup also failed.",
      )
    }
    throw error
  }
  await browser.close()
  return result
}

export function runBrowser<const TName extends BrowserDefinitionName>(
  name: TName,
  ...args: BrowserDefinitionInputArgs<BrowserRegistryDefinition<TName>>
): Promise<BrowserRunResult<BrowserDefinitionResult<BrowserRegistryDefinition<TName>>>>
export function runBrowser<TName extends string>(
  name: string extends TName ? TName : never,
  input?: unknown,
): Promise<BrowserRunResult<unknown>>
export async function runBrowser(name: string, input?: unknown): Promise<BrowserRunResult<unknown>> {
  try {
    const definition = await resolveBrowserDefinition(name)
    return [null, await executeBrowserDefinition(definition, input)]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}
