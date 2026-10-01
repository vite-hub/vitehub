import { describe, expect, it } from "vitest";
import { importSealKey, seal, sealKeyId, sealedPayloadPattern, unseal } from "../src/seal.ts";

const raw = new Uint8Array(32).fill(3);
const aad = (value: string) => new TextEncoder().encode(value);

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("seal", () => {
  it("round-trips a value bound to its additional data", async () => {
    const key = await importSealKey(raw);
    const payload = await seal(key, aad("a"), "secret-value");
    expect(payload).toMatch(sealedPayloadPattern);
    expect(payload).not.toContain("secret-value");
    expect(await unseal(key, aad("a"), payload)).toBe("secret-value");
  });

  it("rejects a different key, additional data, or a malformed payload", async () => {
    const key = await importSealKey(raw);
    const payload = await seal(key, aad("a"), "secret-value");
    await expect(unseal(key, aad("b"), payload)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    const other = await importSealKey(new Uint8Array(32).fill(4));
    await expect(unseal(other, aad("a"), payload)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    await expect(unseal(key, aad("a"), "not-sealed")).rejects.toMatchObject({ code: "SEAL_INVALID" });
    expect(() => importSealKey(new Uint8Array(16))).toThrow(expect.objectContaining({ code: "SEAL_INVALID" }));
  });

  it("reads values sealed by the previous inline Env implementation", async () => {
    const iv = new Uint8Array(12).fill(1);
    const cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(JSON.stringify(["default", "token", "r1"])) },
      cryptoKey,
      new TextEncoder().encode("legacy-value"),
    );
    const legacy = `${hex(iv)}:${hex(new Uint8Array(encrypted))}`;
    const key = await importSealKey(raw);
    expect(await unseal(key, aad(JSON.stringify(["default", "token", "r1"])), legacy)).toBe("legacy-value");
  });

  it("derives a stable key identifier without exposing the key", async () => {
    const id = await sealKeyId(raw);
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(await sealKeyId(raw)).toBe(id);
    expect(await sealKeyId(new Uint8Array(32).fill(4))).not.toBe(id);
  });
});
