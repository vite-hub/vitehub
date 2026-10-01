import { ViteHubError } from "@vite-hub/runtime";

/** Stored sealed value format: `hex(iv):hex(ciphertext)`. */
export const sealedPayloadPattern: RegExp = /^[a-f0-9]{24}:(?:[a-f0-9]{2}){16,}$/;

/** An imported AES-GCM key. */
export type SealKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function sealError(): ViteHubError {
  return new ViteHubError("SEAL_INVALID", "Invalid sealed value or key.");
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw sealError();
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

/** Imports a 32-byte AES-GCM key for `seal` and `unseal`. */
export function importSealKey(key: Uint8Array): Promise<SealKey> {
  if (key.byteLength !== 32) throw sealError();
  return crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Returns a stable public identifier for a raw key: the first 8 bytes of its SHA-256 digest, in hex. */
export async function sealKeyId(key: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(key));
  return hex(new Uint8Array(digest).slice(0, 8));
}

/** Encrypts `plaintext` with AES-GCM and binds it to `additionalData`. */
export async function seal(
  key: SealKey,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${hex(iv)}:${hex(new Uint8Array(encrypted))}`;
}

/** Decrypts a value from `seal`. Fails when the key or `additionalData` differs. */
export async function unseal(
  key: SealKey,
  additionalData: Uint8Array<ArrayBuffer>,
  payload: string,
): Promise<string> {
  if (!sealedPayloadPattern.test(payload)) throw sealError();
  const [iv, ciphertext] = payload.split(":");
  const value = await crypto.subtle
    .decrypt({ name: "AES-GCM", iv: bytes(iv!), additionalData }, key, bytes(ciphertext!))
    .catch(() => {
      throw sealError();
    });
  return new TextDecoder().decode(value);
}
