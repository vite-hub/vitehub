// The `console` page tool: one link in the page tools pill that opens the Console in a new tab.
import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"

// The link takes the pill's text color and font, and follows its light or dark scheme.
const styles = `
:host { display: flex; }
a { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px; color: inherit; font: inherit; font-weight: 500; text-decoration: none; white-space: nowrap; transition: background-color 120ms ease, color 120ms ease; }
a:hover { background: light-dark(rgb(0 0 0 / .05), rgb(255 255 255 / .06)); color: light-dark(#18181b, #fafafa); }
a:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
svg { flex: none; }
@media (prefers-reduced-motion: reduce) { a { transition: none; } }
`

const icon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m7 11 2-2-2-2M11 13h4"/></svg>`

const start: ViteHubPageToolModule["default"] = ({ bar, tool }) => {
  const shadow = bar.attachShadow({ mode: "open" })
  shadow.innerHTML = `<style>${styles}</style><a target="_blank" rel="noopener" title="Open the Console in a new tab">${icon}<span></span></a>`
  const link = shadow.querySelector("a")!
  // This script is one of the Console's assets at `<Console>/assets/`, so the Console path is the part before
  // `/assets/`. It keeps the application base. (Vite rewrites `new URL("..", import.meta.url)` as an asset import.)
  const path = new URL(import.meta.url).pathname
  link.href = path.slice(0, path.lastIndexOf("/assets/"))
  link.lastElementChild!.textContent = tool.label
}

export default start
