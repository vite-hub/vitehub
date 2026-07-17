import { describe, expect, it } from "vitest"

import { detectContentType } from "../src/content-type.ts"

describe("detectContentType", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "image/png"],
    ["JPEG", [0xFF, 0xD8, 0xFF], "image/jpeg"],
    ["GIF87a", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], "image/gif"],
    ["GIF89a", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["BMP", [0x42, 0x4D], "image/bmp"],
    ["WebP", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
    ["little-endian TIFF", [0x49, 0x49, 0x2A, 0x00], "image/tiff"],
    ["big-endian TIFF", [0x4D, 0x4D, 0x00, 0x2A], "image/tiff"],
    ["ICO", [0x00, 0x00, 0x01, 0x00], "image/x-icon"],
    ["PDF", [0x25, 0x50, 0x44, 0x46, 0x2D], "application/pdf"],
  ])("detects %s", (_, input, expected) => {
    expect(detectContentType(Uint8Array.from(input))).toBe(expected)
  })

  it("returns undefined for unknown or truncated content", () => {
    expect(detectContentType(Uint8Array.from([0x89, 0x50]))).toBeUndefined()
    expect(detectContentType(new TextEncoder().encode("<svg></svg>"))).toBeUndefined()
  })
})
