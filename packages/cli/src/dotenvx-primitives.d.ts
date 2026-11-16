// @dotenvx/primitives ships no types. These are the functions the CLI and its tests use.
declare module "@dotenvx/primitives" {
  /** Decrypts an `encrypted:` value with a hex private key. Throws an error with a dotenvx `code`, such as `WRONG_PRIVATE_KEY`. */
  export function decrypt(privateKey: string, value: string): string
  /** Encrypts `value` for a hex public key and returns an `encrypted:` value. */
  export function encrypt(publicKey: string, value: string): string
  /** A new secp256k1 keypair, or the keypair of `privateKey`, as hex strings. */
  export function keypair(privateKey?: string): { privateKey: string, publicKey: string }
}
