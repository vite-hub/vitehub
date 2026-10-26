import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

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

  it("encodes Unicode strings as UTF-8", () => {
    const value = "Hello, 世界 🌍";
    expect(stringToBase64(value)).toBe(Buffer.from(value, "utf8").toString("base64"));
  });
});
