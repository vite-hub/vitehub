/** Lower case without accents, so `jose` finds `José`. Mention suggestions match names this way, in the browser and on the server. */
export function foldName(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}
