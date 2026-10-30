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

const start: ViteHubPageToolModule["default"] = ({ bar, tool }) => {
  const shadow = bar.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = styles
  const link = document.createElement("a")
  link.target = "_blank"
  link.rel = "noopener"
  link.title = "Open the Console in a new tab"
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({ width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value)
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  for (const [name, value] of Object.entries({ width: "18", height: "18", x: "3", y: "3", rx: "2" })) rect.setAttribute(name, value)
  const terminal = document.createElementNS("http://www.w3.org/2000/svg", "path")
  terminal.setAttribute("d", "m7 11 2-2-2-2M11 13h4")
  svg.append(rect, terminal)
  const label = document.createElement("span")
  label.textContent = tool.label
  link.append(svg, label)
  // This script is one of the Console's assets at `<Console>/assets/`, so the Console path is the part before
  // `/assets/`. It keeps the application base. (Vite rewrites `new URL("..", import.meta.url)` as an asset import.)
  const path = new URL(import.meta.url).pathname
  link.href = path.slice(0, path.lastIndexOf("/assets/"))
  shadow.append(style, link)
}

export default start
