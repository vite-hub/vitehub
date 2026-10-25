import { expect, it } from "vitest"
import * as v from "valibot"

import { createCollectionCursorCodec } from "../src/core/collection-cursor.ts"

it.each([{ bytes: [0xff] }, { bytes: [0xc3] }, { bytes: [0xc0, 0xaf] }, { bytes: [0xed, 0xa0, 0x80] }])("rejects invalid UTF-8 bytes $bytes in a cursor", async ({ bytes }) => {
  const codec = createCollectionCursorCodec(v.string())
  const cursor = Buffer.from([0x22, ...bytes, 0x22]).toString("base64url")
  await expect(codec.decode(cursor)).rejects.toMatchObject({ reason: "malformed" })
})

it("round trips Unicode including the literal replacement character", async () => {
  const codec = createCollectionCursorCodec(v.string())
  const value = "日本語 / café / � / 😀"
  await expect(codec.decode(codec.encode(value))).resolves.toBe(value)
})
