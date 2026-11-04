import { describe, expect, it } from "vitest"

import { decodeText } from "../src/internal/windows-1252.ts"

describe("Windows-1252 decoding", () => {
  it("decodes C1 bytes from the Encoding Standard index", () => {
    expect(decodeText(new TextDecoder("windows-1252"), Uint8Array.of(0x41, 0x80, 0x81, 0x9F, 0xE9))).toBe("A€\u0081Ÿé")
    expect(decodeText(new TextDecoder("us-ascii"), Uint8Array.of(0x93, 0x94))).toBe("“”")
  })

  it("leaves other encodings to TextDecoder", () => {
    expect(decodeText(new TextDecoder(), Uint8Array.of(0xC3, 0xA9))).toBe("é")
  })
})
