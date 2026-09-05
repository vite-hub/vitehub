import { browserErrorDiagnostics } from "../error-diagnostics.ts"

import type { BrowserType } from "playwright-core"

export async function loadChromium(): Promise<Pick<BrowserType, "connectOverCDP">> {
  throw browserErrorDiagnostics.BROWSER_R0011({ message: "[vitehub:browser] The built-in Playwright CDP adapter requires Node.js. Use a Cloudflare Browser binding in Workers." })
}
