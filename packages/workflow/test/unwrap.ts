import type { Result } from "@vite-hub/runtime"

export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const [error, data] = await result
  if (error) throw error
  return data
}
