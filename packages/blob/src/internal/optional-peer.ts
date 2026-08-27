export async function importOptionalPeer<T>(id: string, driver: string, installId = id): Promise<T> {
  try {
    return await import(/* @vite-ignore */ id) as T
  }
  catch (error) {
    if (isMissingPeerError(error, id)) {
      throw new Error(`The "${driver}" blob driver requires ${installId}. Install it with: pnpm add ${installId}`)
    }
    throw error
  }
}

function isMissingPeerError(error: unknown, id: string) {
  if (!(error instanceof Error)) return false
  return (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    || (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    || error.message.includes(`Cannot find package '${id}'`)
    || error.message.includes(`Cannot find module '${id}'`)
}
