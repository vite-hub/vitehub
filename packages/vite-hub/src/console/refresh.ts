export function serializeConsoleRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let queue = Promise.resolve()

  return () => {
    const result = queue.then(refresh)
    queue = result.catch(() => {})
    return result
  }
}
