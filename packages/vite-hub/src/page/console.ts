// The Console segment of the page tools pill, at `<base>/_vitehub/console/assets/page-tool.js`. It is a link: it opens
// this app in the hosted Console in a new tab, at the Content document that the page shows when there is one.
import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"

import { consolePageBase, consolePageLink } from "./console-link.ts"

import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"

/** Lucide `arrow-up-right`: the link opens a new tab. */
const newTabIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10M7 17 17 7"/></svg>`

const start: ViteHubPageToolModule["default"] = ({ bar, tool, onOpen }) => {
  const base = consolePageBase(new URL(import.meta.url).pathname)
  // A page origin that the Console cannot open, such as `http:` on a LAN address, gets no segment.
  if (!consolePageLink(location.origin, base)) return
  const shadow = bar.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = viteHubPillButtonStyles
  const button = document.createElement("button")
  button.type = "button"
  button.title = "Open this app in the ViteHub Console, in a new tab"
  button.textContent = tool.label
  button.insertAdjacentHTML("beforeend", newTabIcon)
  const open = () => {
    const fields = [...document.querySelectorAll("[data-content-field]")].map(element => element.getAttribute("data-content-field") ?? "")
    const href = consolePageLink(location.origin, base, fields)
    if (href) window.open(href, "_blank", "noopener")
  }
  button.addEventListener("click", open)
  // The account menu of the pill opens the Console through the loader, as this button does.
  onOpen(open)
  shadow.append(style, button)
}

export default start
