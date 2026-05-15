import { ofetch } from "ofetch"
import { normalizeProviderError } from "./errors.ts"

export function createCIHTTPClient(provider: string, baseURL: string, token: string, extraHeaders: Record<string, string> = {}) {
  const client = ofetch.create({
    baseURL,
    headers: {
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  })

  return async function request<T>(path: string, options?: Record<string, unknown>): Promise<T> {
    try {
      return await client<T>(path, options as never)
    } catch (error) {
      throw normalizeProviderError(error, provider)
    }
  }
}
