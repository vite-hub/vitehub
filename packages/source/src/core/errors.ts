import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

export type SourceErrorCode = "SOURCE_FAILED" | "SOURCE_NOT_FOUND" | "SOURCE_PATH_INVALID"

export function sourceError(message: string, options?: ErrorOptions): ViteHubError {
  return new ViteHubError("SOURCE_FAILED", message, options)
}

export function sourceNotFoundError(name: string): ViteHubError {
  return new ViteHubError("SOURCE_NOT_FOUND", `[vitehub] Source "${name}" is not registered.`, {
    details: { name },
  })
}

export function sourcePathError(path: string): ViteHubError {
  return new ViteHubError("SOURCE_PATH_INVALID", `[vitehub] Source path escapes the source root: ${JSON.stringify(path)}.`, {
    details: { path },
  })
}

export function isSourceError(value: unknown): boolean {
  const code = getViteHubErrorShape(value)?.code
  return code === "SOURCE_FAILED" || code === "SOURCE_NOT_FOUND" || code === "SOURCE_PATH_INVALID"
}
