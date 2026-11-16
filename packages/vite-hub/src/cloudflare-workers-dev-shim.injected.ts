// Source of `.nuxt/vitehub/cloudflare-workers.dev.mjs`, the `cloudflare:workers` stub for Node development.
// It runs in the app, not in this package, so its errors stay plain.
export const cloudflareWorkersDevShimSource: string = [
  "const bindings = () => globalThis.__env__ ?? process.env",
  "const read = key => bindings()[key] ?? process.env[key]",
  "export const env = new Proxy({}, {",
  "  get: (_, key) => read(key),",
  "  has: (_, key) => key in bindings() || key in process.env,",
  "  ownKeys: () => [...new Set([...Reflect.ownKeys(process.env), ...Reflect.ownKeys(bindings())])],",
  "  getOwnPropertyDescriptor(_, key) {",
  "    const descriptor = Object.getOwnPropertyDescriptor(bindings(), key) ?? Object.getOwnPropertyDescriptor(process.env, key)",
  "    return descriptor && { configurable: true, enumerable: descriptor.enumerable, writable: true, value: read(key) }",
  "  },",
  "})",
  "export async function waitUntil(promise) { if (globalThis.__wait_until__) return globalThis.__wait_until__(promise); await promise }",
  "export function withEnv() { throw new Error('cloudflare.withEnv is not available in Node development.') }",
  "class Unsupported { constructor() { throw new Error('This Cloudflare runtime class is not available in Node development.') } }",
  "export { Unsupported as DurableObject, Unsupported as RpcTarget, Unsupported as WorkerEntrypoint, Unsupported as WorkflowEntrypoint }",
  "",
].join("\n")
