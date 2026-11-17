// Sources of the `.nuxt/vitehub/cloudflare-*.dev.mjs` stubs that stand in for Cloudflare runtime modules in Node
// development. They run in the app, not in this package, so their errors stay plain.
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

/** `cloudflare:email`: generated Email modules import `EmailMessage`, which only the `EMAIL` binding reads. */
export const cloudflareEmailDevShimSource: string = [
  "export class EmailMessage {",
  "  constructor(from, to, raw) {",
  "    this.from = from",
  "    this.to = to",
  "    this.raw = raw",
  "  }",
  "}",
  "",
].join("\n")
