import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { bytesToBase64, stringToBase64 } from "../src/drivers/shared.ts";

describe("Email Base64 with Buffer", () => {
  it.each([0, 1, 2, 3, 65_536])("encodes only the %i-byte subarray", (length) => {
    const source = Uint8Array.from({ length: length + 13 }, (_, index) => index % 256);
    const value = source.subarray(7, 7 + length);
    expect(bytesToBase64(value)).toBe(Buffer.from(value).toString("base64"));
  });

  it("encodes only a pooled Buffer slice", () => {
    const source = Buffer.from("before:attachment:after");
    expect(bytesToBase64(source.subarray(7, 17))).toBe("YXR0YWNobWVudA==");
  });

  it("copies a shared-backed subarray before encoding", () => {
    const source = new Uint8Array(new SharedArrayBuffer(5));
    source.set([99, 1, 2, 3, 99]);
    const value = source.subarray(1, 4);
    const originalToString = Buffer.prototype.toString;
    const toString = vi.spyOn(Buffer.prototype, "toString").mockImplementationOnce(function (this: Buffer, encoding) {
      // Model another worker writing after the Buffer is created, before encoding.
      value.fill(0);
      return originalToString.call(this, encoding);
    });
    try {
      expect(bytesToBase64(value)).toBe("AQID");
    } finally {
      toString.mockRestore();
    }
  });

  it("encodes Unicode strings as UTF-8", () => {
    const value = "Hello, 世界 🌍";
    expect(stringToBase64(value)).toBe(Buffer.from(value, "utf8").toString("base64"));
  });
});
