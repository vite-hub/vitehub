import { createBrowser } from "vite-hub/browser"
import { localBrowser } from "vite-hub/browser/providers/local"

// The OAuth provider of a sign-in is not a backend, so the codemod leaves it.
const signIn = { provider: "github" }

export default defineEventHandler(async () => {
  const browser = createBrowser({ driver: localBrowser({ executablePath: "/usr/bin/chromium" }) })
  return { signIn, browser: Boolean(browser) }
})
