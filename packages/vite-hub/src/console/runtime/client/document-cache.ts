const cachePrefix = "vitehub.console.documents:"

/** Remove responses persisted by older Console versions; grants can change within one session. */
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
