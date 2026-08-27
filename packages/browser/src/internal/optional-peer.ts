export async function importBrowserOptionalPeer<T>(id: string): Promise<T> {
  return await import(id) as T
}
