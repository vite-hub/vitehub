declare const defineNuxtConfig: typeof import('nuxt/config').defineNuxtConfig

// The host binding fixture uses the part of `wrangler types` output that its route needs.
declare namespace Cloudflare {
  interface Env {
    VIDEOS: {
      get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>
    }
  }
}
