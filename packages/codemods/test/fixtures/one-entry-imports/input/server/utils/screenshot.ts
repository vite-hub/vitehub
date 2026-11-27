import { isBrowserAvailable, runBrowserAction } from "vite-hub/browser/actions"

export async function screenshot(url: string) {
  if (!isBrowserAvailable()) return undefined
  return runBrowserAction("screenshot", { url })
}
