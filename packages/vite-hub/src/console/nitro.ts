import { join } from "node:path"

import { addDevframeNitroHandler } from "devframe/adapters/h3"

export function addConsoleDevframeHandler(nitro: { handlers?: Array<{ handler: string; route: string }> }, consoleRuntimeRoot: string): void {
  addDevframeNitroHandler(nitro, {
    base: "/_vitehub/rpc/",
    handler: join(consoleRuntimeRoot, "server/devframe.js"),
  })
}
