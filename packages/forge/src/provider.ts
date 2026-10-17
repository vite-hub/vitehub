import type { ForgeProvider } from "forges"

/** The Forges that ViteHub supports. */
export type ForgeKind = "github" | "gitlab" | "forgejo"

export interface ForgeConnection {
  forge: ForgeKind
  /** GitHub: API base. GitLab and Forgejo: instance root. */
  baseUrl?: string
  /** Omitted: anonymous public reads. */
  token?: string
  readOnly?: boolean
  fetch?: typeof fetch
  /** Default "vitehub". */
  userAgent?: string
}

/** Create the library provider for one Forge. Internal to ViteHub packages: never return it from a public API. */
export async function forgeProvider(connection: ForgeConnection): Promise<ForgeProvider> {
  const auth = connection.token
    ? { type: "token" as const, token: connection.token }
    : { type: "anonymous" as const }
  const options = {
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(connection.fetch ? { fetch: connection.fetch } : {}),
    userAgent: connection.userAgent ?? "vitehub",
    ...(connection.readOnly === undefined ? {} : { readOnly: connection.readOnly }),
    auth,
  }
  switch (connection.forge) {
    case "github": {
      const { github } = await import("forges/github")
      return github(options).create()
    }
    case "gitlab": {
      const { gitlab } = await import("forges/gitlab")
      return gitlab(options).create()
    }
    case "forgejo": {
      const { forgejo } = await import("forges/forgejo")
      return forgejo(options).create()
    }
  }
  throw new Error("Unsupported Forge.")
}

/** A Forge response that succeeded but did not include the expected data. */
export class ForgeResponseError extends Error {
  override name = "ForgeResponseError"
}

/** The HTTP status of a failed Forge request, or undefined for other errors. */
export function forgeErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("status" in error)) return undefined
  return typeof error.status === "number" ? error.status : undefined
}

/** The error that a cancelled Forge operation rejects with. */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted.", "AbortError")
}

/** Reject with the abort reason when `signal` aborts before `promise` settles. */
export async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw abortError(signal)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal))
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}
