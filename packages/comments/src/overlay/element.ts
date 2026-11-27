import { commentsClientDiagnostics, warnDiagnostic } from "../client-diagnostics.ts"

/** The element of the app's own Comments overlay. */
export const appOverlayElement = "vitehub-comments"

/** The element of the Hosted Comments overlay, apart from the app's, so the app's overlay can always start. */
export const hostedOverlayElement = "vitehub-hosted-comments"

export const hostedDraftEvent = "vitehub:hosted-comments-draft"

export interface HostedDraftRequest {
  draft?: { ready: Promise<void>, stop: () => void }
}

export function pendingHostedDraft(): HostedDraftRequest["draft"] {
  const detail: HostedDraftRequest = {}
  document.querySelector(hostedOverlayElement)?.dispatchEvent(new CustomEvent(hostedDraftEvent, { detail }))
  return detail.draft
}

/**
 * Whether the page runs the app's own Comments. Hosted Comments then stay off, and the browser console gets
 * `COMMENTS_HOSTED_CONFLICT`.
 */
export function appCommentsRunning(): boolean {
  if (!customElements.get(appOverlayElement)) return false
  warnDiagnostic(commentsClientDiagnostics.COMMENTS_HOSTED_CONFLICT())
  return true
}
