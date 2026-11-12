import { parseURL } from 'ufo'
import { kv } from 'vite-hub/kv'

export default eventHandler(async (event) => {
  // Skip during prerendering
  if (import.meta.prerender) return

  const { pathname } = parseURL(event.path)
  const [error, redirects] = await kv.get<{ [key: string]: string }>('redirects')
  if (error) throw error

  if (redirects?.[pathname]) {
    return sendRedirect(event, redirects[pathname])
  }
})
