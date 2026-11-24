import { withBrowserTimeout } from "./internal/timeout.ts"
import browserRegistry from "#vitehub/browser/registry"
import runtimeConfig, { loadCloudflarePlaywright } from "#vitehub/browser/runtime"

import { browserProviderError } from "./errors.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { browserRunErrors } from "./run-errors.ts"
import { browserUnavailableError, isBrowserAvailable } from "./availability.ts"
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
  BrowserDriverOpenOptions,
  BrowserSession,
} from "./types.ts"
import type { CDPClient } from "./controllers/cdp.ts"
import type { PlaywrightBrowserConnection } from "./internal/connections.ts"
import type {
  BrowserDefinitionInputArgs,
  BrowserDefinitionName,
  BrowserDefinitionOutput,
  BrowserRegistryDefinition,
} from "./registry-types.ts"
import type { BrowserRunErrorCode } from "./run-errors.ts"
import type { Result } from "@vite-hub/runtime"
import { browserErrorDiagnostics } from "./error-diagnostics.ts"

async function boundedCleanup(cleanup: Promise<void>, operation = "close the browser after setup failure"): Promise<void> {
  await withBrowserTimeout(cleanup, () => browserProviderError("cdp", operation))
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
  private readonly opening = new Set<Promise<BrowserPageSession>>()

  constructor(private readonly options: BrowserDefinitionRuntimeOptions) {}

  async content(input: BrowserActionInput): Promise<string> {
    const [error, content] = await runBrowserContent(input)
    if (error) throw error
    return content
  }

  async run(action: BrowserAction, input: BrowserActionInput): Promise<Response> {
    return await runBrowserAction(action, input)
  }

  async open(options?: BrowserDriverOpenOptions): Promise<BrowserPageSession> {
    const opening = this.openSession(options)
    this.opening.add(opening)
    try {
      return await opening
    }
    finally {
      this.opening.delete(opening)
    }
  }

  private async openSession(options?: BrowserDriverOpenOptions): Promise<BrowserPageSession> {
    const providerSession = await (this.options.client ?? resolveConfiguredClient()).open(options)
    let control: BrowserControl<CDPClient> | undefined
    try {
      control = await withBrowserTimeout(providerSession.attach(this.options.controller ?? cdp()), () => browserProviderError("cdp", "attach the browser controller"))
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
    while (this.opening.size > 0) await Promise.allSettled(this.opening)
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
  if (!isBrowserAvailable() || runtimeConfig.driver !== "cloudflare") throw browserUnavailableError()
  const configuredLoader = loadCloudflarePlaywright
    ?? (() => importBrowserOptionalPeer<CloudflarePlaywrightDriver>("@cloudflare/playwright"))
  configuredClient = createBrowser({
    driver: createCloudflareBrowser(
      {
        binding: runtimeConfig.binding,
        engine: runtimeConfig.engine,
      },
      configuredLoader,
    ),
  })
  return configuredClient
}

function isBrowserDefinition(value: unknown): value is BrowserDefinition {
  return !!value
    && typeof value === "object"
    && Object.hasOwn(value, "run")
    && typeof (value as { run?: unknown }).run === "function"
}

function readBrowserDefinition(name: string, loaded: unknown): BrowserDefinition {
  const definition = loaded
    && (typeof loaded === "object" || typeof loaded === "function")
    && "default" in loaded
    && loaded.default
    ? loaded.default
    : loaded
  if (!isBrowserDefinition(definition)) {
    throw browserErrorDiagnostics.BROWSER_R0009({ message: `[vitehub:browser] Browser Definition ${JSON.stringify(name)} must default-export defineBrowser().` })
  }
  return definition
}

export function defineBrowser<TInput = unknown, TResult = unknown>(
  run: BrowserDefinitionHandler<TInput, TResult>,
): BrowserDefinition<TInput, TResult> {
  if (typeof run !== "function") {
    throw browserErrorDiagnostics.BROWSER_R0010({ message: "[vitehub:browser] defineBrowser() requires a Browser Definition handler." })
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

/**
 * Run a Browser Definition by its name. `data` is the value that the handler returned, such as a string or a `Response`.
 * An unknown name returns `BROWSER_DEFINITION_NOT_FOUND`; an import, handler, or provider failure returns `BROWSER_RUN_FAILED`.
 * A build without Browser and a file that does not default-export `defineBrowser()` throw.
 */
export function runBrowser<const TName extends BrowserDefinitionName>(
  name: TName,
  ...args: BrowserDefinitionInputArgs<BrowserRegistryDefinition<TName>>
): Promise<Result<BrowserDefinitionOutput<BrowserRegistryDefinition<TName>>, BrowserRunErrorCode>>
export function runBrowser<TName extends string>(
  name: string extends TName ? TName : never,
  input?: unknown,
): Promise<Result<unknown, BrowserRunErrorCode>>
export async function runBrowser(name: string, input?: unknown): Promise<Result<unknown, BrowserRunErrorCode>> {
  if (!isBrowserAvailable()) throw browserUnavailableError()
  const entry = Object.hasOwn(browserRegistry, name) ? browserRegistry[name] : undefined
  if (!entry) return [browserRunErrors.BROWSER_DEFINITION_NOT_FOUND({ name }), undefined]

  let loaded: unknown
  try {
    loaded = typeof entry === "function" ? await entry() : entry
  }
  catch (cause) {
    return [browserRunErrors.BROWSER_RUN_FAILED({ name, cause }), undefined]
  }

  const definition = readBrowserDefinition(name, loaded)
  try {
    return [undefined, await executeBrowserDefinition(definition, input)]
  }
  catch (error) {
    if (getViteHubErrorShape(error)?.code === "BROWSER_UNAVAILABLE") throw error
    return [browserRunErrors.BROWSER_RUN_FAILED({ name, cause: error }), undefined]
  }
}
