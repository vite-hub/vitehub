import { loadConsoleNavigation } from "./sections"

const cachePrefix = "vitehub.console.documents:"

/** Validate the current session before restoring permission-filtered document data. */
export async function consoleDocumentCacheIdentity(sectionsBase: string): Promise<string | undefined> {
  try {
    const navigation = await loadConsoleNavigation(sectionsBase)
    // Without a stable authenticated identity, there is no safe owner for a persisted response.
    if (!navigation?.auth) return undefined
    const authBase = sectionsBase.replace(/\/sections$/, "/auth")
    const access = navigation.auth === "cloudflare-access"
    const sessionBase = document.querySelector('meta[name="vitehub-console-auth-base"]')?.getAttribute("content") || authBase
    const response = await fetch(access ? `${authBase}/identity` : `${sessionBase}/get-session?disableCookieCache=true`, {
      cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" },
    })
    if (!response.ok) return undefined
    // SAFETY: Optional JSON fields are validated before being used as an identity.
    const value = await response.json() as {
      email?: unknown, commonName?: unknown, user?: { id?: unknown }, session?: { id?: unknown },
    } | null
    if (access) {
      if (typeof value?.email === "string" && value.email) return JSON.stringify(["cloudflare-access", "email", value.email])
      if (typeof value?.commonName === "string" && value.commonName) return JSON.stringify(["cloudflare-access", "commonName", value.commonName])
    }
    else if (typeof value?.user?.id === "string" && value.user.id && typeof value.session?.id === "string" && value.session.id) {
      return JSON.stringify(["session", value.user.id, value.session.id])
    }
  }
  catch {
    // Identity failures disable the cache; the document requests still report their own errors.
  }
  return undefined
}

/** Sign-out and authorization failures discard document responses from every section in this tab. */
export function clearConsoleDocumentCaches(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(cachePrefix)) sessionStorage.removeItem(key)
    }
  }
  catch {
    // Storage may be blocked by the browser.
  }
}
