import { Buffer as NodeBuffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeCloudflareMimeMessage } from "../src/drivers/cloudflare-mime.ts";
import { bytesToBase64, stringToBase64 } from "../src/drivers/shared.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Email Base64 without Buffer", () => {
  it.each([0, 1, 2, 3, 12_287, 12_288, 12_289, 65_536])("preserves bytes and padding for a %i-byte subarray", (length) => {
    const source = Uint8Array.from({ length: length + 13 }, (_, index) => index % 256);
    const value = source.subarray(7, 7 + length);
    const expected = NodeBuffer.from(value).toString("base64");
    vi.stubGlobal("Buffer", undefined);
    expect(bytesToBase64(value)).toBe(expected);
  });

  it("encodes Unicode strings as UTF-8", () => {
    const value = "Hello, 世界 🌍".repeat(2_000);
    const expected = NodeBuffer.from(value, "utf8").toString("base64");
    vi.stubGlobal("Buffer", undefined);
    expect(stringToBase64(value)).toBe(expected);
  });

  it("preserves a multipart attachment through MIME folding", () => {
    const content = Uint8Array.from({ length: 65_537 }, (_, index) => index % 256);
    const expected = NodeBuffer.from(content).toString("base64").match(/.{1,76}/g)!.join("\r\n");
    vi.stubGlobal("Buffer", undefined);
    const raw = encodeCloudflareMimeMessage({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Attachment",
      text: "hello",
      attachments: [{ filename: "file.bin", content }],
    }, "<test@example.com>");
    expect(raw).toContain(`Content-Disposition: attachment; filename="file.bin"\r\n\r\n${expected}\r\n--`);
  });
});
