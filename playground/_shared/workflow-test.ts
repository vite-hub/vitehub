export function resolveTrustedWorkflowMarkerCallbackUrl(requestUrl: URL, callbackUrl: string | undefined) {
  if (!callbackUrl) {
    return undefined
  }

  const resolved = new URL(callbackUrl, requestUrl)
  if (resolved.origin !== requestUrl.origin || resolved.pathname !== "/api/tests/workflow") {
    return undefined
  }

  if (resolved.search || resolved.hash) {
    return undefined
  }

  return resolved.toString()
}
