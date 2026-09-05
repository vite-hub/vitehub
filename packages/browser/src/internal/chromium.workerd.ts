import type { BrowserType } from "playwright-core"

export async function loadChromium(): Promise<Pick<BrowserType, "connectOverCDP">> {
  throw new Error("[vitehub:browser] The built-in Playwright CDP adapter requires Node.js. Use a Cloudflare Browser binding in Workers.")
}
