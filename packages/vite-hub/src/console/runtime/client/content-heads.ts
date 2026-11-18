import { requestConsoleOperation } from "./request"

/** The last GitHub push webhook delivery of a `github()` Source, as `content.head` answers it. */
export interface ConsoleContentWebhook {
  id: string | null
  at: string
  sha: string | null
  result: "failed" | "kept" | "moved" | "pinned" | "rejected"
  error?: string
}

/** The head of one `github()` Source, as `content.head` answers it. The Content page shows these fields. */
export interface ConsoleContentHead {
  source: string
  live: boolean
  sha: string | null
  ref: string | null
  movedAt: string | null
  pinned: boolean
  rejected: { sha: string, at: string, reason: string } | null
  webhook: ConsoleContentWebhook | null
  diagnostic: { code: string, message: string, fix: string } | null
}

type Tone = "error" | "neutral" | "success" | "warning"

/** The heads of the app's `github()` Sources. An app without one answers an empty list. */
export async function readContentHeads(signal?: AbortSignal): Promise<ConsoleContentHead[]> {
  // SAFETY: `content.head` answers `{ heads }` with one head for each `github()` Source.
  const value = await requestConsoleOperation("content.head", {}, signal ? { signal } : {}) as { heads?: unknown } | null
  return Array.isArray(value?.heads) ? value.heads as ConsoleContentHead[] : []
}

/** The first 7 characters of a commit SHA, as GitHub shows it. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7)
}

/** What the head of a Source does now: it follows its branch, a pin holds it, a diagnostic holds it back, or it is not live. */
export function contentHeadStatus(head: Pick<ConsoleContentHead, "diagnostic" | "live" | "pinned">): { label: string, tone: Tone } {
  if (!head.live) return { label: "Not live", tone: "neutral" }
  if (head.pinned) return { label: "Pinned", tone: "warning" }
  if (head.diagnostic) return { label: "Held back", tone: "error" }
  return { label: "Live", tone: "success" }
}

/** What the last push webhook did, such as `Moved the head to 4f9c2e1`. */
export function contentWebhookResult(webhook: ConsoleContentWebhook): { label: string, tone: Tone } {
  const commit = webhook.sha ? ` ${shortCommit(webhook.sha)}` : ""
  switch (webhook.result) {
    case "moved": return { label: `Moved the head to${commit}`, tone: "success" }
    case "kept": return { label: `Kept the head at${commit}`, tone: "neutral" }
    case "pinned": return { label: `Kept the pin, ignored${commit}`, tone: "warning" }
    case "rejected": return { label: `Rejected${commit}`, tone: "error" }
    case "failed": return { label: webhook.error ? `Failed: ${webhook.error}` : "Failed", tone: "error" }
  }
}
