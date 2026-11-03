// WHATWG windows-1252 index for bytes 0x80 to 0x9F. The other bytes map to the same code point.
const c1 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ"

/**
 * Decode `bytes` with `decoder`. Node.js 22.18 decodes Windows-1252 C1 bytes as Latin-1,
 * so this decodes Windows-1252 from the Encoding Standard index on every runtime.
 */
export function decodeText(decoder: { readonly encoding: string, decode(input: Uint8Array): string }, bytes: Uint8Array): string {
  if (decoder.encoding !== "windows-1252") return decoder.decode(bytes)
  let text = ""
  for (const byte of bytes) text += byte >= 0x80 && byte <= 0x9F ? c1[byte - 0x80] : String.fromCharCode(byte)
  return text
}
