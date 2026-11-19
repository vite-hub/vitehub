import { createBrowserEnvironment as createEnvironment, postOnce } from "@vite-hub/internal/browser-environment"

import type { BrowserEnvironment, BrowserEvent } from "@vite-hub/internal/browser-environment"

/** A page event that the store reacts to. */
type SyncEvent = BrowserEvent

/** A message between tabs. `change` tells that the stored copy of a Sync route changed. */
type SyncMessage = { type: "change", id: string } | { type: "clear" }

/** What the store needs from the browser. Tests pass a fake one. */
type SyncEnvironment = BrowserEnvironment<SyncMessage>

const channel = "vitehub-sync"

function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== "object") return false
  const type: unknown = Reflect.get(value, "type")
  return type === "clear" || (type === "change" && typeof Reflect.get(value, "id") === "string")
}

function createBrowserEnvironment(): SyncEnvironment {
  return createEnvironment({ channel, isMessage: isSyncMessage })
}

/** Tells the other tabs that every store was cleared. */
function postClear(): void {
  postOnce(channel, { type: "clear" } satisfies SyncMessage)
}

export { createBrowserEnvironment, postClear }
export type { SyncEnvironment, SyncEvent, SyncMessage }
