import { consoleMountBase } from "../console-route.ts"
import { consoleRequestURL } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** The hosted Console. A production build without `console.embed` links there instead of serving the Console pages. */
export const hostedConsoleUrl = "https://console.vitehub.dev"

/**
 * Answers `/_vitehub` and its pages in a production build without `console.embed: true`. The answer is plain text and
 * loads no Console code, so the app serves no Console pages or assets.
 */
export default function consoleNotEmbeddedHandler(event: ConsoleRequestEvent): Response {
  const url = consoleRequestURL(event)
  const project = `${url.origin}${consoleMountBase(url.pathname)}`
  return new Response(`The Console is not embedded in this app. Open it at ${hostedConsoleUrl} and link ${project}, or set console.embed: true.\n`, {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}
