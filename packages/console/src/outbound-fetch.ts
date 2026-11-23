import { lookup } from "node:dns"

import { Agent, fetch as undiciFetch } from "undici"

import { isPrivateHost } from "./project-url.ts"

import type { LookupAddress, LookupOptions } from "node:dns"

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

function isPrivateAddress({ address, family }: LookupAddress): boolean {
  return isPrivateHost(family === 6 ? `[${address}]` : address)
}

function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, [])
    const refused = addresses.find(isPrivateAddress)
    if (refused) return callback(Object.assign(new Error(`${hostname} resolves to the private address ${refused.address}.`), { code: "ECONNREFUSED" }), [])
    if (options.all) return callback(null, addresses)
    const [first] = addresses
    if (!first) return callback(Object.assign(new Error(`${hostname} has no address.`), { code: "ENOTFOUND" }), [])
    callback(null, first.address, first.family)
  })
}

let publicAgent: Agent | undefined

/**
 * The fetch that the Console server uses to reach MCP and OAuth servers on Node. It refuses to connect to a private,
 * loopback, link-local, or unique-local address at connect time, so a public name that resolves to one fails. With
 * `allowPrivate`, it is the global fetch.
 */
export function consoleOutboundFetch(allowPrivate: boolean): typeof fetch {
  if (allowPrivate) return fetch
  return async (input, init) => {
    const request = new Request(input, init)
    publicAgent ??= new Agent({ connect: { lookup: publicLookup } })
    const response = await undiciFetch(request.url, {
      body: request.body ? await request.arrayBuffer() : null,
      dispatcher: publicAgent,
      headers: Array.from(request.headers),
      method: request.method,
      redirect: request.redirect,
      signal: request.signal,
    })
    return new Response(response.body, { headers: Array.from(response.headers), status: response.status, statusText: response.statusText })
  }
}
