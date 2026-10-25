import { createCommentsClient } from "@vite-hub/comments/client"
import { createRpcTransport } from "@vite-hub/comments/rpc"
import { CommentLayer, CommentList, CommentToolbar } from "@vite-hub/ui/comments"
import { createApp, defineComponent, h, shallowRef, watch } from "vue"
import type { App } from "vue"

import css from "./overlay.css?inline"
import { UButton, UIcon } from "./shim.ts"
import type { OverlaySession } from "./loader-core.ts"

export interface OverlayOptions {
  /** The app base, such as `/` or `/portal/`. */
  base: string
  session: OverlaySession
}

export interface OverlayHandle {
  app: App
  destroy: () => void
  host: HTMLElement
}

/** Where the Edit button goes: the Console editor of the document at this page. */
interface EditTarget {
  collection: string
  id: string
}

/** The page path below the app base: `/portal/pricing` under `/portal/` is `/pricing`. */
function appPath(base: string): string {
  const prefix = base.replace(/\/$/, "")
  const { pathname } = globalThis.location
  return prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`)) ? pathname.slice(prefix.length) || "/" : pathname
}

/**
 * Calls `listener` after each client-side navigation: `history.pushState`, `history.replaceState`, and `popstate`.
 * Returns a function that undoes the patch.
 */
export function trackNavigation(listener: () => void): () => void {
  const { history } = globalThis
  const push = history.pushState
  const replace = history.replaceState
  history.pushState = function pushState(...args) {
    push.apply(this, args)
    listener()
  }
  history.replaceState = function replaceState(...args) {
    replace.apply(this, args)
    listener()
  }
  globalThis.addEventListener("popstate", listener)
  return () => {
    // Leave another library's patch alone if it wrapped ours.
    if (history.pushState !== push) history.pushState = push
    if (history.replaceState !== replace) history.replaceState = replace
    globalThis.removeEventListener("popstate", listener)
  }
}

/** The shadow root keeps the page's styles out and these styles in. `:root` tokens of the stylesheet become `:host`. */
function adoptStyles(shadow: ShadowRoot): void {
  const text = css.replaceAll(":root", ":host")
  if ("adoptedStyleSheets" in shadow && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
    shadow.adoptedStyleSheets = [sheet]
    return
  }
  const style = document.createElement("style")
  style.textContent = text
  shadow.append(style)
}

async function resolveDocument(base: string, path: string): Promise<EditTarget | null> {
  try {
    const response = await globalThis.fetch(`${base.replace(/\/$/, "")}/_vitehub/rpc/__call`, {
      body: JSON.stringify({ input: { path }, operation: "content.resolve" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-vitehub-console": "1" },
      method: "POST",
    })
    // An app without the Content cms preset has no such operation, so the call fails and there is no Edit button.
    if (!response.ok) return null
    const body = await response.json() as { ok?: boolean, value?: { collection?: unknown, id?: unknown } | null }
    const value = body.ok === true ? body.value : null
    return value && typeof value.collection === "string" && typeof value.id === "string" ? { collection: value.collection, id: value.id } : null
  }
  catch {
    return null
  }
}

/** Mounts the comment parts into a shadow root on the page. Called by the loader once the visitor may read comments. */
export function mount(options: OverlayOptions): OverlayHandle {
  const base = options.base.endsWith("/") ? options.base : `${options.base}/`
  const prefix = base.replace(/\/$/, "")
  const { session } = options

  const host = document.createElement("div")
  host.setAttribute("data-comments-ui", "")
  host.setAttribute("data-comments-overlay", "")
  const shadow = host.attachShadow({ mode: "open" })
  adoptStyles(shadow)
  const root = document.createElement("div")
  if (!session.canWrite) root.setAttribute("data-readonly", "")
  shadow.append(root)

  const subject = shallowRef({ id: appPath(base), kind: "page" })
  const edit = shallowRef<EditTarget | null>(null)
  let latest = 0
  const lookup = async (path: string) => {
    const ticket = ++latest
    const found = await resolveDocument(base, path)
    if (ticket === latest) edit.value = found
  }
  const stopTracking = trackNavigation(() => {
    const id = appPath(base)
    if (id !== subject.value.id) subject.value = { id, kind: "page" }
  })
  watch(() => subject.value.id, id => void lookup(id), { immediate: true })

  const client = createCommentsClient({
    transport: createRpcTransport({ base: prefix }),
    ...(session.user ? { user: session.user } : {}),
  })
  const navigate = (href: string) => globalThis.location.assign(prefix && href.startsWith("/") && !href.startsWith(`${prefix}/`) ? `${prefix}${href}` : href)

  const Overlay = defineComponent({
    name: "CommentsOverlay",
    setup() {
      return () =>
        h(CommentLayer, { client, hotkey: session.canWrite ? "c" : false, navigate, subject: subject.value, ...(session.user ? { user: session.user } : {}) }, {
          default: ({ comments }: { comments: never }) => [
            h(CommentToolbar, { comments }, {
              default: () => edit.value
                ? h("a", { "data-slot": "comment-toolbar-edit", href: `${prefix}/_vitehub/content/${encodeURIComponent(edit.value.collection)}/${encodeURIComponent(edit.value.id)}`, title: "Edit this page" }, [h(UIcon, { name: "i-ph-pencil-simple-light" }), "Edit"])
                : null,
            }),
            // SAFETY: `comments` is the CommentsState that the layer provides.
            (comments as { listOpen: { value: boolean } }).listOpen.value ? h(CommentList, { comments, navigate }) : null,
          ],
        })
    },
  })

  const app = createApp(Overlay)
  app.component("UButton", UButton)
  app.component("UIcon", UIcon)
  app.mount(root)
  document.body.append(host)

  return {
    app,
    destroy() {
      stopTracking()
      app.unmount()
      host.remove()
    },
    host,
  }
}
