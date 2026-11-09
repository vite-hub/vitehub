/**
 * Related links in a page pill: a button for one of the pill's segments, and the menu it opens beside the pill. The
 * tool decides which links there are. `resolve` returns them when someone opens the menu, and `show()` says whether the
 * button shows before that, for example after a cheap check that the page has any.
 *
 * This file runs only in the browser. `vite-hub/page/pill.js` ships it with the pill.
 */
import { viteHubPageSvgIcon } from "./page-pill.ts"

import type { ViteHubPagePillPlace } from "./page-pill.ts"

/** One link in the menu. */
export interface ViteHubPageLink {
  url: string
  label: string
  /** Small text at the end of the row, such as the host. */
  detail?: string
  /**
   * The icon's addresses, such as the site's favicons, tried in turn with no referrer. When none loads, the row shows a
   * link icon. A GitHub link always shows GitHub's mark, in the text color.
   */
  icons?: readonly string[]
}

export interface ViteHubPageLinksOptions {
  /** The `slot` of the pill segment that holds the button. */
  slot: string
  /** The button's text and the menu's heading. Default: "Related links". */
  label?: string
  /**
   * The links to list, in order, all alike. The menu calls it when it opens, and keeps the answer until `forget()`. It runs in the
   * press, before any `await`, so it may open a popup, such as a sign-in window. When it throws, the menu shows the
   * error's message, or closes when the message is empty.
   */
  resolve: () => Promise<readonly ViteHubPageLink[]>
  /** What the menu says when `resolve` finds no links. Default: "No related links." */
  empty?: string
  /** Runs when the menu opens, so the tool can close its other cards. */
  onOpen?: () => void
  /** Removes the button and the menu, and stops listening to the page. */
  signal: AbortSignal
}

export interface ViteHubPageLinks {
  /** The pill segment with the button. Append it to the pill. */
  segment: HTMLElement
  /** The menu. Put it in the same root as `viteHubPageLinksStyles`, outside the pill. */
  menu: HTMLElement
  /** Shows or hides the button. It starts hidden. Hiding it closes the menu. */
  show: (visible: boolean) => void
  /** Opens the menu, as a press on the button does. */
  open: () => Promise<void>
  close: () => void
  isOpen: () => boolean
  /** Drops the links that `resolve` gave, so the next open asks again, for example after a sign-out. */
  forget: () => void
  /** Moves the menu beside the pill, on its edge. Call it from the pill's `onPlace`. */
  place: (place: ViteHubPagePillPlace) => void
}

/**
 * The menu's styles. The menu has the pill's dark glass and the same font, so it reads as part of it. The button takes
 * the pill's own button styles from its segment.
 */
export const viteHubPageLinksStyles: string = `.vitehub-links{position:fixed;z-index:2147483002;box-sizing:border-box;width:min(320px,calc(100vw - 16px));max-height:min(420px,calc(100dvh - 96px));overflow-y:auto;overscroll-behavior:contain;margin:0;padding:4px;border:1px solid rgb(255 255 255/12%);border-radius:12px;background:rgb(17 17 17/96%);box-shadow:0 8px 24px rgb(0 0 0/25%);color-scheme:dark;color:#d4d4d4;font:500 13px/18px ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.vitehub-links[hidden]{display:none}
.vitehub-links p{margin:0;padding:6px 8px 4px;color:#a3a3a3;font-size:12px}
.vitehub-links p[role=status]{padding:6px 8px;color:#d4d4d4;font-size:13px}
.vitehub-links ul{margin:0;padding:0;list-style:none}
.vitehub-links a{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 8px;border-radius:8px;color:#d4d4d4;font-weight:400;text-decoration:none;outline:none}
@media(hover:hover){.vitehub-links a:hover{background:rgb(255 255 255/8%);color:#fafafa}}
.vitehub-links a:focus-visible{background:rgb(255 255 255/8%);box-shadow:inset 0 0 0 2px #fafafa}
.vitehub-links-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vitehub-links-detail{min-width:0;max-width:40%;overflow:hidden;color:#a3a3a3;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.vitehub-links-icon{width:16px;height:16px;flex:none;border-radius:3px;object-fit:contain}
.vitehub-links svg{flex:none;color:#a3a3a3}
.vitehub-links .vitehub-links-github{color:inherit}
@media(any-pointer:coarse){.vitehub-links a{min-height:44px}}`

// The icons draw with inline styles, and the classes have the menu's prefix, so the tool's own styles in the same root,
// such as `.seg svg` or `.icon`, can't change them.
const stroke = (size: number) => ({ width: `${size}`, height: `${size}`, style: `width:${size}px;height:${size}px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round` })
const linkIcon = (size = 16) => viteHubPageSvgIcon("0 0 24 24", "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71", stroke(size))
const outIcon = () => viteHubPageSvgIcon("0 0 24 24", "M7 17 17 7M7 7h10v10", stroke(14))
// GitHub's favicon is a black mark that the dark menu would hide, so its Simple Icons mark takes the text color.
const githubMark = () => viteHubPageSvgIcon("0 0 24 24", "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .32.21.69.82.57A12 12 0 0 0 12 .3", { width: "16", height: "16", style: "width:16px;height:16px;fill:currentColor;stroke:none", class: "vitehub-links-github" })

function isGitHub(url: string): boolean {
  try { return /^(?:www\.)?github\.com$/.test(new URL(url).hostname) }
  catch { return false }
}

/** The row's icon: GitHub's mark, the first of `icons` that loads, or a link icon. */
function linkIconFor(link: ViteHubPageLink): Element {
  if (isGitHub(link.url)) return githubMark()
  const tries = [...link.icons ?? []]
  if (tries.length === 0) return linkIcon()
  const image = document.createElement("img")
  image.className = "vitehub-links-icon"
  image.alt = ""
  image.referrerPolicy = "no-referrer"
  image.decoding = "async"
  const next = () => {
    const url = tries.shift()
    if (url) image.src = url
    else image.replaceWith(linkIcon())
  }
  image.addEventListener("error", next)
  next()
  return image
}

/**
 * Draws a Related links button for a page pill and the menu it opens. The tool resolves the links. The menu closes on
 * Esc, on a press outside it, and when a link opens.
 */
export function mountViteHubPageLinks(options: ViteHubPageLinksOptions): ViteHubPageLinks {
  const { signal } = options
  const label = options.label ?? "Related links"
  const segment = document.createElement("div")
  segment.slot = options.slot
  segment.hidden = true
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("aria-expanded", "false")
  button.setAttribute("aria-haspopup", "true")
  button.append(linkIcon(14), label)
  segment.append(button)
  const menu = document.createElement("nav")
  menu.className = "vitehub-links"
  menu.setAttribute("aria-label", label)
  menu.hidden = true
  button.setAttribute("aria-controls", menu.id = `vitehub-links-${Math.random().toString(36).slice(2)}`)

  let links: readonly ViteHubPageLink[] | undefined
  let pending: Promise<readonly ViteHubPageLink[]> | undefined
  let asked = 0

  const close = () => {
    menu.hidden = true
    button.setAttribute("aria-expanded", "false")
  }
  const row = (link: ViteHubPageLink): HTMLLIElement => {
    const item = document.createElement("li")
    const anchor = document.createElement("a")
    anchor.href = link.url
    anchor.target = "_blank"
    anchor.rel = "noopener noreferrer"
    anchor.title = `${link.label}\n${link.url}`
    const name = document.createElement("span")
    name.className = "vitehub-links-name"
    name.textContent = link.label
    anchor.append(linkIconFor(link), name)
    if (link.detail) {
      const detail = document.createElement("span")
      detail.className = "vitehub-links-detail"
      detail.textContent = link.detail
      anchor.append(detail)
    }
    anchor.append(outIcon())
    anchor.setAttribute("aria-label", `${link.label}${link.detail ? `, ${link.detail}` : ""} (opens in a new tab)`)
    anchor.addEventListener("click", close)
    item.append(anchor)
    return item
  }
  const draw = (content: readonly ViteHubPageLink[] | string) => {
    const heading = document.createElement("p")
    heading.textContent = label
    menu.replaceChildren(heading)
    if (typeof content === "string") {
      const status = document.createElement("p")
      status.setAttribute("role", "status")
      status.textContent = content
      menu.append(status)
      return
    }
    const list = document.createElement("ul")
    list.append(...content.map(row))
    menu.append(list)
  }
  // A press outside the menu and its button closes it. The menu may sit in a closed shadow root, where a press on the
  // page reaches `window` without the menu in its path, so the root that holds the menu listens too.
  let listening: Node | undefined
  const outside = (event: Event) => {
    const path = event.composedPath()
    if (!menu.hidden && !path.includes(menu) && !path.includes(segment)) close()
  }
  const listen = () => {
    const root = menu.getRootNode()
    if (root === listening || !(root instanceof ShadowRoot)) return
    listening = root
    root.addEventListener("pointerdown", outside, { capture: true, signal })
  }
  const show = (content: readonly ViteHubPageLink[] | string) => {
    listen()
    options.onOpen?.()
    draw(content)
    menu.hidden = false
    button.setAttribute("aria-expanded", "true")
    menu.querySelector("a")?.focus({ preventScroll: true })
  }

  const open = async () => {
    if (links) return show(links.length ? links : options.empty ?? "No related links.")
    // `resolve` runs now, in the press, so it may still open a popup.
    const ask = ++asked
    pending ??= options.resolve()
    const answer = pending
    button.setAttribute("aria-busy", "true")
    try {
      const found = await answer
      if (ask !== asked || signal.aborted) return
      links = found
      show(links.length ? links : options.empty ?? "No related links.")
    }
    catch (error) {
      if (ask !== asked || signal.aborted) return
      const message = error instanceof Error ? error.message : ""
      if (message) show(message)
      else close()
    }
    finally {
      if (pending === answer) pending = undefined
      if (ask === asked) button.removeAttribute("aria-busy")
    }
  }

  button.addEventListener("click", () => {
    if (!menu.hidden) close()
    else void open()
  }, { signal })

  // Esc closes the menu and gives the focus back to the button when it was in the menu.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden || event.isComposing) return
    const inMenu = event.composedPath().includes(menu)
    event.stopPropagation()
    close()
    if (inMenu) button.focus({ preventScroll: true })
  }, { capture: true, signal })
  window.addEventListener("pointerdown", (event) => {
    const root = menu.getRootNode()
    // Inside a shadow root the root's own listener sees the whole path.
    if (root instanceof ShadowRoot && event.composedPath().includes(root.host)) return
    outside(event)
  }, { capture: true, signal })

  signal.addEventListener("abort", () => {
    segment.remove()
    menu.remove()
  }, { once: true })

  return {
    segment,
    menu,
    show: (visible) => {
      segment.hidden = !visible
      if (!visible) close()
    },
    open,
    close,
    isOpen: () => !menu.hidden,
    forget: () => {
      links = undefined
      pending = undefined
      asked++
      button.removeAttribute("aria-busy")
      close()
    },
    place: (place) => {
      const side = place.edge === "left" || place.edge === "right"
      const style = menu.style
      style.left = style.right = style.top = style.bottom = style.translate = ""
      style[place.edge] = `${(place.collapsed ? 2 : 16) + place.thickness + 8}px`
      const start = side ? "top" : "left"
      const end = side ? "bottom" : "right"
      if (place.at === 50) {
        style[start] = "50%"
        style.translate = side ? "0 -50%" : "-50% 0"
      }
      else style[place.at < 50 ? start : end] = "16px"
    },
  }
}
