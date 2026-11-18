/**
 * The account item of the page tools pill: the picture or the initials of the person who is signed in to the app, and a
 * menu with their name, their email, how they signed in, and a way to sign out of this app only.
 *
 * The menu is an auto popover that the button opens with `popovertarget`, so it shows in the top layer (the pill's bar
 * clips everything inside it), and the browser closes it on Escape and on a press outside. It is a menu button of
 * WAI-ARIA: the menu opens with the focus on its first item, the arrow keys move between items, and the focus goes back
 * to the button when the menu closes with the focus in it.
 *
 * Script places the menu, not CSS anchor positioning: the pill moves along its edge with `translate`, and Firefox
 * ignores the transforms of an anchor (https://webstatus.dev/features/anchor-positioning-transforms).
 *
 * This file runs only in the browser. `tsconfig.browser.json` checks it.
 */
import { installMotion } from "@vite-hub/ui/motion"

import { viteHubPageSvgIcon } from "./page-pill.ts"
import { viteHubPageToolsLinkParams, viteHubPageToolsQuery, viteHubPillButtonStyles } from "./page-tools-shared.ts"

import type { ViteHubPageAccount } from "./page-tools-shared.ts"

export interface ViteHubPageAccountOptions {
  account: ViteHubPageAccount
  /** The account segment of the pill, such as `<vitehub-account slot="account">`, a child of the pill. */
  bar: HTMLElement
  /** The ViteHub mark, a path in a 20 by 18 box. The line "Signed in with ViteHub Console" shows it. */
  mark: string
  /**
   * The action of the item "Open in the Console", or `undefined` when the pill shows no Console link. The menu asks each
   * time it opens.
   */
  openConsole?: () => (() => void) | undefined
  /** Removes the item when it aborts. */
  signal: AbortSignal
}

const styles = `${viteHubPillButtonStyles}
.who{align-self:flex-start;padding:0 3px}
.avatar{box-sizing:border-box;display:grid;place-items:center;width:22px;height:22px;flex:none;overflow:hidden;border-radius:50%;background:#404040;color:var(--vitehub-pill-strong);font-size:10px;font-weight:600;line-height:1}
.avatar img{display:block;width:100%;height:100%;object-fit:cover}
[role=menu]{position:fixed;inset:auto;box-sizing:border-box;width:max-content;min-width:220px;max-width:min(300px,calc(100vw - 16px));margin:0;padding:6px;overflow:visible;border:1px solid var(--vitehub-pill-line);border-radius:12px;background:#171717;color:var(--vitehub-pill-text);font:500 13px/1.3 ui-sans-serif,system-ui,sans-serif;box-shadow:0 16px 40px rgb(0 0 0/30%);color-scheme:dark}
.me{display:flex;align-items:center;gap:10px;margin-bottom:4px;padding:8px 8px 10px;border-bottom:1px solid var(--vitehub-pill-line)}
.me .avatar{width:32px;height:32px;font-size:12px}
.me div{min-width:0}
.me b,.me small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.me b{color:var(--vitehub-pill-strong);font-weight:500}
.me small{margin-top:2px;color:var(--vitehub-pill-muted);font-size:12px}
.via{display:flex;align-items:center;gap:6px;padding:6px 8px;color:var(--vitehub-pill-muted);font-size:12px}
.via svg{width:11px;height:10px;flex:none;fill:var(--vitehub-pill-text)}
[role=menuitem]{display:flex;width:100%;height:32px;justify-content:flex-start;gap:8px;font-size:13px}
[role=menuitem] svg{width:15px;height:15px;color:var(--vitehub-pill-muted)}
[role=menuitem][hidden]{display:none}
[role=menuitem][aria-disabled=true]{cursor:progress}
@media(any-pointer:coarse){[role=menuitem]{height:44px}}`

/** Lucide `arrow-up-right`, as the Console link of the pill. */
const openIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10M7 17 17 7"/></svg>`
/** Lucide `log-out`. */
const signOutIcon = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 17 5-5-5-5M21 12H9M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>`

/** The first letters of the first two words of a name, such as `AL` for `Ada Lovelace`. */
export function viteHubPageInitials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toLocaleUpperCase()
}

/** The picture of the person, or their initials when there is none or it does not load. */
function avatar(account: ViteHubPageAccount): HTMLElement {
  const element = document.createElement("span")
  element.className = "avatar"
  element.setAttribute("aria-hidden", "true")
  element.textContent = viteHubPageInitials(account.name)
  if (account.image) {
    const image = document.createElement("img")
    image.alt = ""
    image.referrerPolicy = "no-referrer"
    image.src = account.image
    image.addEventListener("load", () => element.replaceChildren(image), { once: true })
  }
  return element
}

function menuItem(icon: string, text: string): { item: HTMLButtonElement, label: HTMLSpanElement } {
  const item = document.createElement("button")
  item.type = "button"
  item.setAttribute("role", "menuitem")
  item.tabIndex = -1
  item.insertAdjacentHTML("beforeend", icon)
  const label = document.createElement("span")
  label.textContent = text
  item.append(label)
  return { item, label }
}

/** The page without the page tools query and the link parameters of tools, so a reload does not load the pill again. */
function pageWithoutTools(): URL {
  const url = new URL(location.href)
  for (const name of [viteHubPageToolsQuery, ...viteHubPageToolsLinkParams]) url.searchParams.delete(name)
  return url
}

/**
 * Draws the account item in `bar`. Sign out posts to `account.signOut`, which ends the app session only. Auth's answer
 * clears the `vitehub_session` marker and the `vitehub-tools` hint, so the page reloads without the pill.
 */
export function mountViteHubPageAccount(options: ViteHubPageAccountOptions): void {
  const { account, bar, signal } = options
  const pill = bar.parentElement
  const shadow = bar.attachShadow({ mode: "open" })
  // The motion layer watches the states inside the account item, such as its menu button.
  signal.addEventListener("abort", installMotion(shadow), { once: true })
  const style = document.createElement("style")
  style.textContent = styles

  const menu = document.createElement("div")
  menu.id = "account-menu"
  menu.setAttribute("popover", "auto")
  menu.setAttribute("role", "menu")
  menu.setAttribute("aria-label", account.name)

  const button = document.createElement("button")
  button.type = "button"
  button.className = "who"
  button.title = account.email ? `${account.name} (${account.email})` : account.name
  button.setAttribute("aria-label", `Account: ${account.name}`)
  button.setAttribute("aria-haspopup", "menu")
  button.setAttribute("aria-expanded", "false")
  button.setAttribute("aria-controls", menu.id)
  button.setAttribute("popovertarget", menu.id)
  button.append(avatar(account))

  const me = document.createElement("div")
  me.className = "me"
  me.setAttribute("role", "none")
  const names = document.createElement("div")
  const name = document.createElement("b")
  name.textContent = account.name
  names.append(name)
  if (account.email) {
    const email = document.createElement("small")
    email.textContent = account.email
    names.append(email)
  }
  me.append(avatar(account), names)
  menu.append(me)
  if (account.via === "console") {
    const via = document.createElement("div")
    via.className = "via"
    via.setAttribute("role", "none")
    via.append(viteHubPageSvgIcon("0 0 20 18", options.mark, {}), "Signed in with ViteHub Console")
    menu.append(via)
  }
  const open = menuItem(openIcon, "Open in the Console")
  const signOut = menuItem(signOutIcon, `Sign out of ${location.host}`)
  menu.append(open.item, signOut.item)
  shadow.append(style, button, menu)

  const items = () => [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].filter(item => !item.hidden)
  let openConsole: (() => void) | undefined
  // Place the menu next to the pill, toward the page, then clamp its measured width on horizontal docks once it shows.
  const place = (edge: string) => {
    const width = document.documentElement.clientWidth
    const height = document.documentElement.clientHeight
    const around = (pill ?? bar).getBoundingClientRect()
    const box = button.getBoundingClientRect()
    const place = { top: "auto", right: "auto", bottom: "auto", left: "auto" }
    if (edge === "bottom" || edge === "top") {
      place.right = `${Math.max(8, width - box.right)}px`
      if (edge === "bottom") place.bottom = `${height - around.top + 8}px`
      else place.top = `${around.bottom + 8}px`
    }
    else {
      if (box.top < height / 2) place.top = `${Math.max(8, box.top)}px`
      else place.bottom = `${Math.max(8, height - box.bottom)}px`
      if (edge === "left") place.left = `${around.right + 8}px`
      else place.right = `${width - around.left + 8}px`
    }
    Object.assign(menu.style, place)
  }
  const clamp = (edge: string) => {
    if (edge !== "bottom" && edge !== "top") return
    const width = document.documentElement.clientWidth
    const box = button.getBoundingClientRect()
    const menuWidth = menu.getBoundingClientRect().width
    menu.style.right = "auto"
    menu.style.left = `${Math.max(8, Math.min(box.right - menuWidth, width - menuWidth - 8))}px`
  }

  menu.addEventListener("beforetoggle", (event) => {
    if (event.newState === "closed") {
      if (menu.contains(shadow.activeElement)) button.focus({ preventScroll: true })
      return
    }
    openConsole = options.openConsole?.()
    open.item.hidden = !openConsole
    const edge = pill?.getAttribute("edge") ?? "bottom"
    place(edge)
    // The menu shows right after this event, and before the next frame.
    requestAnimationFrame(() => clamp(edge))
  }, { signal })
  menu.addEventListener("toggle", (event) => {
    const opened = event.newState === "open"
    button.setAttribute("aria-expanded", String(opened))
    if (opened) items()[0]?.focus({ preventScroll: true })
  }, { signal })
  menu.addEventListener("keydown", (event) => {
    const list = items()
    const at = list.findIndex(item => item === shadow.activeElement)
    const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : undefined
    if (next !== undefined) {
      event.preventDefault()
      list[(next + list.length) % list.length]?.focus()
    }
    // The browser closes the menu on Escape. The page's own Escape keys, such as the one that leaves comment mode, do
    // not see it.
    else if (event.key === "Escape") event.stopPropagation()
    else if (event.key === "Tab") menu.hidePopover()
  }, { signal })

  open.item.addEventListener("click", () => {
    menu.hidePopover()
    openConsole?.()
  }, { signal })
  signOut.item.addEventListener("click", async () => {
    if (signOut.item.getAttribute("aria-disabled") === "true") return
    signOut.item.setAttribute("aria-disabled", "true")
    signOut.label.textContent = "Signing out…"
    const response = await fetch(account.signOut, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch((error: unknown) => error)
    if (!(response instanceof Response) || !response.ok) {
      console.error("[vitehub] The sign-out failed. The session stays.", response instanceof Response ? `The sign-out answered ${response.status}.` : response)
      signOut.item.removeAttribute("aria-disabled")
      signOut.label.textContent = "Could not sign out. Try again"
      return
    }
    const url = pageWithoutTools()
    if (url.href === location.href) location.reload()
    else location.replace(url)
  }, { signal })

  // The menu belongs to the bar: it closes when the pill folds, moves, or goes away.
  if (pill) {
    // The pill sets `edge` again each time it measures itself, so only a new value counts.
    const watched = new MutationObserver((records) => {
      if (records.some(record => record.oldValue !== pill.getAttribute(record.attributeName ?? ""))) menu.hidePopover()
    })
    watched.observe(pill, { attributes: true, attributeOldValue: true, attributeFilter: ["collapsed", "dragging", "edge"] })
    signal.addEventListener("abort", () => watched.disconnect(), { once: true })
  }
  signal.addEventListener("abort", () => menu.hidePopover(), { once: true })
}
