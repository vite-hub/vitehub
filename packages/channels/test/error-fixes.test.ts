import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { channelsErrorDiagnostics } from "../src/error-diagnostics.ts"
import { webhook } from "../src/adapters.ts"
import { defineChannel } from "../src/index.ts"
import { hubChannels } from "../src/vite.ts"

const fixedCodes = [
  "CHANNELS_C0001",
  "CHANNELS_C0007",
  "CHANNELS_C0008",
  "CHANNELS_C0009",
  "CHANNELS_C0010",
  "CHANNELS_C0011",
] as const

it("gives each Channels build and definition code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = channelsErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/channels/diagnostics/${code.toLowerCase()}`)
  }
})

it("names the adapter when defineChannel() has none", () => {
  // SAFETY: The test passes options that the types reject, as a JavaScript caller can.
  expect(() => defineChannel({} as never)).toThrow(expect.objectContaining({
    code: "CHANNELS_C0007",
    fix: expect.stringContaining("defineChannel({ adapter })"),
  }))
})

it("names signature and secret when a webhook adapter cannot verify requests", () => {
  // SAFETY: The types reject a secret without a signature. The test passes it, as a JavaScript caller can.
  expect(() => defineChannel({ adapter: webhook({ secret: "s" } as never) })).toThrow(expect.objectContaining({
    code: "CHANNELS_C0011",
    fix: expect.stringContaining("`secret: false`"),
  }))
})

it("names the webhook host when a webhook Channel builds without the Agent plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "channels-error-fixes-"))
  try {
    await mkdir(join(root, "server/channels"), { recursive: true })
    await writeFile(join(root, "server/channels/payments.ts"), "import { defineChannel } from 'vite-hub/channels'\nimport { stripe } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: stripe() })")
    // SAFETY: configResolved reads only `plugins` and `root` in this test.
    const configure = hubChannels().configResolved as unknown as (config: { plugins: Array<{ name: string }>, root: string }) => Promise<void>
    await expect(configure({ plugins: [], root })).rejects.toMatchObject({
      code: "CHANNELS_WEBHOOK_HOST_OFF",
      fix: expect.stringContaining("Remove `agent: false`"),
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
