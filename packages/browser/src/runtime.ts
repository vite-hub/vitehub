import browserRegistry from "#vitehub/browser/registry"
import runtimeConfig from "#vitehub/browser/runtime"

import type { PlaywrightClient } from "./controllers/playwright.ts"
import {
  browserDefinitionNotFoundError,
  browserRuntimeNotConfiguredError,
  toBrowserError,
} from "./errors.ts"
import { createBrowser } from "./client.ts"
import { cloudflarePlaywright } from "./internal/cloudflare-playwright.ts"
import { cloudflareBrowser } from "./providers/cloudflare.ts"

import type {
  BrowserClient,
  BrowserControl,
  BrowserController,
  BrowserDefinition,
  BrowserDefinitionBrowser,
  BrowserDefinitionHandler,
  BrowserPageSession,
  BrowserProviderOpenOptions,
  BrowserRunResult,
  BrowserSession,
} from "./types.ts"
import type {
  BrowserDefinitionInputArgs,
  BrowserDefinitionName,
  BrowserDefinitionResult,
  BrowserRegistryDefinition,
} from "./registry-types.ts"

function closeErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

class ManagedBrowserPageSession<TConnection> implements BrowserPageSession {
  readonly browser
  readonly context
  readonly id
  readonly page
  private closed = false

  constructor(
    private readonly providerSession: BrowserSession<TConnection>,
    private readonly control: BrowserControl<PlaywrightClient>,
  ) {
    this.browser = control.client.browser
    this.context = control.client.context
    this.id = providerSession.id
    this.page = control.client.page
  }

  inspect() {
    return this.providerSession.inspect()
  }

  async close(): Promise<void> {
    if (this.closed) return
    const errors: unknown[] = []
    try {
      await this.control.release()
    }
    catch (error) {
      errors.push(error)
    }
    try {
      await this.providerSession.close()
    }
    catch (error) {
      errors.push(error)
    }
    if (errors.length === 0) this.closed = true
    closeErrors(errors, "[vitehub:browser] Browser Session controller and provider cleanup failed.")
  }
}

class BrowserDefinitionBrowserImpl<TConnection> implements BrowserDefinitionBrowser {
  private readonly sessions: Array<ManagedBrowserPageSession<TConnection>> = []

  constructor(
    private readonly client: BrowserClient<TConnection>,
    private readonly controller: BrowserController<PlaywrightClient, TConnection>,
  ) {}

  async open(options?: BrowserProviderOpenOptions): Promise<BrowserPageSession> {
    const providerSession = await this.client.open(options)
    let control: BrowserControl<PlaywrightClient>
    try {
      control = await providerSession.attach(this.controller)
    }
    catch (error) {
      try {
        await providerSession.close()
      }
      catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "[vitehub:browser] Browser Session setup failed and provider cleanup also failed.",
        )
      }
      throw error
    }
    const session = new ManagedBrowserPageSession(providerSession, control)
    this.sessions.push(session)
    return session
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

let configuredClient: BrowserClient | undefined

function resolveConfiguredClient(): BrowserClient {
  if (configuredClient) return configuredClient
  if (runtimeConfig.provider !== "cloudflare") throw browserRuntimeNotConfiguredError()
  configuredClient = createBrowser({
    provider: cloudflareBrowser({ binding: runtimeConfig.binding }),
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

export async function executeBrowserDefinition<TInput, TResult, TConnection>(
  definition: BrowserDefinition<TInput, TResult>,
  input: TInput,
  options: {
    client: BrowserClient<TConnection>
    controller?: BrowserController<PlaywrightClient, TConnection>
  },
): Promise<TResult> {
  const browser = new BrowserDefinitionBrowserImpl(
    options.client,
    options.controller ?? cloudflarePlaywright() as BrowserController<PlaywrightClient, TConnection>,
  )
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
    return [null, await executeBrowserDefinition(definition, input, {
      client: resolveConfiguredClient(),
    })]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}
