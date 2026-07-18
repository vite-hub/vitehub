import { sourceProviderRequestError, sourceProviderResponseInvalidError } from "../../core/errors.ts"

export async function requestGitHubJson<T>(input: {
  operation: string
  signal?: AbortSignal
  token?: string
  url: string
}): Promise<T> {
  const response = await requestGitHub(input.operation, input.signal, () => fetch(input.url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "user-agent": "vitehub-source",
      "x-github-api-version": "2022-11-28",
    },
    signal: input.signal,
  }))

  if (!response.ok) {
    throw sourceProviderRequestError("github", input.operation, { status: response.status })
  }

  try {
    return await response.json() as T
  }
  catch (cause) {
    if (input.signal?.aborted) throw input.signal.reason
    throw sourceProviderResponseInvalidError("github", input.operation, { cause })
  }
}

export async function fetchGitHubArchive(input: {
  ref: string
  repo: string
  signal?: AbortSignal
  token?: string
}) {
  const operation = "read-archive"
  const response = await requestGitHub(operation, input.signal, () => fetch(`https://codeload.github.com/${input.repo}/tar.gz/${encodeURIComponent(input.ref)}`, {
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "user-agent": "vitehub-source",
    },
    signal: input.signal,
  }))

  if (!response.ok) {
    throw sourceProviderRequestError("github", operation, { status: response.status })
  }

  try {
    return new Uint8Array(await response.arrayBuffer())
  }
  catch (cause) {
    if (input.signal?.aborted) throw input.signal.reason
    throw sourceProviderResponseInvalidError("github", operation, { cause })
  }
}

async function requestGitHub(operation: string, signal: AbortSignal | undefined, request: () => Promise<Response>): Promise<Response> {
  try {
    return await request()
  }
  catch (cause) {
    if (signal?.aborted) throw signal.reason
    throw sourceProviderRequestError("github", operation, { cause })
  }
}
