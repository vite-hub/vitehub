import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

import { commentRoom } from "../src/page.ts"

describe("built Comments overlay", () => {
  it.each(["", "/portal", "/nested/portal"])("uses the asset's app base %s for presence and changes", async (base) => {
    // Native ESM evaluation preserves import.meta.url without rewriting the prebuilt overlay.
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-vm-modules",
      fileURLToPath(new URL("./fixtures/overlay-built.mjs", import.meta.url)),
      base,
    ])
    expect(JSON.parse(stdout)).toEqual([
      `wss://site.test${base}/api/_vitehub/realtime/comments/${commentRoom("/articles/example")}`,
      `wss://site.test${base}/api/_vitehub/realtime/comments/%40workspace?workspace=events`,
    ])
  })
})
