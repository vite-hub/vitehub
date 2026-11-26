import { isRecord } from "@vite-hub/internal/object"

import { useConsoleProjects } from "./project-session"
import { ConsoleRequestError, consoleResponseError } from "./request"

/** A link that the Console answers, such as a one-time code or a guest invite, and when it stops working. */
export interface ConsoleLink {
  url: string
  expiresAt: string
}

interface ConsoleTab {
  close(): void
  location: { replace(url: string): void }
  opener: unknown
}

function isTab(value: unknown): value is ConsoleTab {
  return typeof value === "object" && value !== null && "close" in value && "location" in value
}

function openTab(): ConsoleTab | undefined {
  const open: unknown = Reflect.get(globalThis, "open")
  const tab: unknown = open instanceof Function ? Reflect.apply(open, globalThis, ["about:blank", "_blank"]) : undefined
  return isTab(tab) ? tab : undefined
}

/**
 * Ask for a link and open it in a new tab. The tab opens before the call, while the click still allows it, and closes
 * again when the call fails. The app page cannot reach the Console through `opener`. When the browser blocks the tab,
 * this tab goes to the link.
 */
export async function openConsoleLink(request: () => Promise<unknown>): Promise<void> {
  const tab = openTab()
  if (tab) tab.opener = null
  try {
    const url: unknown = Reflect.get(Object(await request()), "url")
    if (String(url) !== url) throw new ConsoleRequestError(502, "The Console did not return a link.")
    if (tab) tab.location.replace(url)
    else Reflect.apply(Reflect.get(Object(Reflect.get(globalThis, "location")), "assign"), Reflect.get(globalThis, "location"), [url])
  }
  catch (error) {
    tab?.close()
    throw error
  }
}

/**
 * Open the app in a new tab as a user, end that impersonation, or open the page of a document with its draft. The
 * Console asks the app first, as you, and keeps what to open for 60 seconds in this browser. The tab goes through the
 * app's `/_vitehub/site`, and the Console signs a token for it.
 */
export async function openSiteAction(kind: "impersonate" | "preview", target: Record<string, string>): Promise<void> {
  await openConsoleLink(async () => {
    const project = useConsoleProjects().current.value
    if (!project) throw new ConsoleRequestError(409, "Open a project first.")
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/site/open`, {
      body: JSON.stringify({ kind, target }),
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
    })
    if (!response.ok) throw await consoleResponseError(response)
    const body: unknown = await response.json().catch(() => undefined)
    if (!isRecord(body)) throw new ConsoleRequestError(502, "The Console answered with no JSON object.")
    return body
  })
}
