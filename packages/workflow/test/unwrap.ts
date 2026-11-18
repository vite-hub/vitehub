import type { Result } from "@vite-hub/runtime"

/** Reads the data of a Workflow call that the test expects to succeed. It throws the error of a failed call. */
export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const [error, data] = await result
  if (error) throw error
  return data
}
