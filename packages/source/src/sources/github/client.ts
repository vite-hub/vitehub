import { sourceError } from "../../core/errors.ts"

export async function requestGitHubJson<T>(input: {
  ref: string
  repo: string
  signal?: AbortSignal
  token?: string
  url: string
}): Promise<T> {
  const response = await fetch(input.url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "user-agent": "vitehub-source",
      "x-github-api-version": "2022-11-28",
    },
    signal: input.signal,
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw sourceError(`[vitehub] github(${JSON.stringify(input.repo)}) could not access the repository or ref ${JSON.stringify(input.ref)}. Check that the repo exists, the ref exists, and auth can access it.`)
    }
    throw sourceError(`[vitehub] github(${JSON.stringify(input.repo)}) request failed with ${response.status} for ${input.url}.`)
  }

  return await response.json() as T
}

export async function fetchGitHubArchive(input: {
  ref: string
  repo: string
  signal?: AbortSignal
  token?: string
}) {
  const response = await fetch(`https://codeload.github.com/${input.repo}/tar.gz/${encodeURIComponent(input.ref)}`, {
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      "user-agent": "vitehub-source",
    },
    signal: input.signal,
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw sourceError(`[vitehub] github(${JSON.stringify(input.repo)}) could not access the repository or ref ${JSON.stringify(input.ref)}. Check that the repo exists and the ref exists.`)
    }
    throw sourceError(`[vitehub] github(${JSON.stringify(input.repo)}) archive request failed with ${response.status}.`)
  }

  return new Uint8Array(await response.arrayBuffer())
}
