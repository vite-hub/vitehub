export const Sandbox = {
  async create() {
    throw new Error("@vercel/sandbox is not available in the Cloudflare Nitro playground build.")
  },
  async get() {
    return null
  },
  async list() {
    return { sandboxes: [] }
  },
}
