import browserRegistry from "#vitehub/browser/registry"

import {
  browserDefinitionNotFoundError,
  toBrowserError,
} from "./errors.ts"
import { runBrowserAction, runBrowserContent } from "./actions.ts"

import type {
  BrowserAction,
  BrowserActionInput,
  BrowserDefinition,
  BrowserDefinitionBrowser,
  BrowserDefinitionHandler,
  BrowserRunResult,
} from "./types.ts"
import type {
  BrowserDefinitionInputArgs,
  BrowserDefinitionName,
  BrowserDefinitionResult,
  BrowserRegistryDefinition,
} from "./registry-types.ts"

class BrowserDefinitionBrowserImpl implements BrowserDefinitionBrowser {
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
): Promise<TResult> {
  const browser = new BrowserDefinitionBrowserImpl()
  return await definition.run(input, { browser })
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
