import { ConsoleRequestError } from "./request.ts"

/** The answer of an operation that returns a one-time link. Mirrors `ConsoleTicket` of the server. */
export interface ConsoleTicketLink {
  url: string
  expiresAt: string
}

/** The part of a browser tab that the Console uses. The package's server build has no DOM types. */
interface ConsoleTab {
  close(): void
  location: { replace(url: string): void }
  opener: unknown
}

// The window of a new tab belongs to another realm, so `instanceof Object` is false for it.
function isTab(value: unknown): value is ConsoleTab {
  return typeof value === "object" && value !== null && "close" in value && "location" in value
}

/** A new blank tab, or `undefined` when the browser blocks it. */
function openTab(): ConsoleTab | undefined {
  const open: unknown = Reflect.get(globalThis, "open")
  const tab: unknown = open instanceof Function ? Reflect.apply(open, globalThis, ["about:blank", "_blank"]) : undefined
  return isTab(tab) ? tab : undefined
}

/**
 * Ask for a one-time link, such as with the `auth.impersonate` operation, and open it in a new tab. The tab opens before
 * the call, while the click still allows it, and closes again when the call fails. The app page cannot reach the
 * Console through `opener`. When the browser blocks the tab, this tab goes to the link.
 */
export async function openConsoleTicket(request: () => Promise<unknown>): Promise<void> {
  const tab = openTab()
  if (tab) tab.opener = null
  try {
    const url: unknown = Reflect.get(Object(await request()), "url")
    if (String(url) !== url) throw new ConsoleRequestError(502, "The app did not return a link.")
    if (tab) tab.location.replace(url)
    else Reflect.apply(Reflect.get(Object(Reflect.get(globalThis, "location")), "assign"), Reflect.get(globalThis, "location"), [url])
  }
  catch (error) {
    tab?.close()
    throw error
  }
}
