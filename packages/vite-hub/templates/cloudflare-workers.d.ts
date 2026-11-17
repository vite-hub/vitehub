// What ViteHub's generated Cloudflare server files import from the Workers runtime, for apps without
// `@cloudflare/workers-types`. With that package installed, ViteHub references its full types instead.
// The types match `@cloudflare/workers-types` and `wrangler types`, so the bindings that an app declares on
// `Cloudflare.Env` still type `env` when both declarations are in the program.
declare namespace Cloudflare {
  interface Env {}
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env
  export function waitUntil(promise: Promise<unknown>): void
}
