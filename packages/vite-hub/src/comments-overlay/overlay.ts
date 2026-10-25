import { createCommentsClient } from "@vite-hub/comments/client"
import { createRpcTransport } from "@vite-hub/comments/rpc"
import { CommentLayer, CommentList, CommentToolbar } from "@vite-hub/ui/comments"
import { createApp, defineComponent, h, shallowRef, watch } from "vue"
import type { App } from "vue"

import css from "./overlay.css?inline"
import { UButton, UIcon } from "./shim.ts"
import type { MountOptions, OverlayControl } from "./loader-core.ts"

export interface OverlayHandle extends OverlayControl {
  app: App
  destroy: () => void
  host: HTMLElement
}

/** Where the Edit button goes: the Console editor of the document at this page. */
interface EditTarget {
  collection: string
  id: string
}

/** The theme that the app picked on `<html>`, or undefined when it leaves the choice to the system. */
export function appTheme(root: Element): "dark" | "light" | undefined {
  const named = [root.getAttribute("data-theme"), (root as HTMLElement).style?.colorScheme, root.getAttribute("data-color-scheme")].map(value => value?.trim().toLowerCase())
  if (root.classList.contains("dark") || named.includes("dark")) return "dark"
  if (root.classList.contains("light") || named.includes("light")) return "light"
  return undefined
}

/**
 * Makes the host follow the app's theme: the `dark` class (for `:host(.dark)`) and `color-scheme`. Without a choice from
 * the app the host keeps `color-scheme: light dark`, which follows `prefers-color-scheme`. Returns a function that stops.
 */
function followTheme(host: HTMLElement): () => void {
  const root = document.documentElement
  const apply = () => {
    const theme = appTheme(root)
    host.classList.toggle("dark", theme === "dark")
    host.style.colorScheme = theme ?? ""
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributeFilter: ["class", "data-theme", "data-color-scheme", "style"], attributes: true })
  return () => observer.disconnect()
}

/** The shadow root keeps the page's styles out and these styles in. The stylesheet's `.dark` and `:root` become `:host`. */
function adoptStyles(shadow: ShadowRoot, nonce: string | undefined): void {
  const text = css.replaceAll(":root.dark", ":host(.dark)").replaceAll(":root", ":host")
  if ("adoptedStyleSheets" in shadow && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
    shadow.adoptedStyleSheets = [sheet]
    return
  }
  const style = document.createElement("style")
  if (nonce) style.setAttribute("nonce", nonce)
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
export function mount(options: MountOptions): OverlayHandle {
  const base = options.base.endsWith("/") ? options.base : `${options.base}/`
  const prefix = base.replace(/\/$/, "")
  const { session } = options

  const host = document.createElement("div")
  host.setAttribute("data-comments-ui", "")
  host.setAttribute("data-comments-overlay", "")
  const shadow = host.attachShadow({ mode: "open" })
  adoptStyles(shadow, options.nonce)
  const root = document.createElement("div")
  if (!session.canWrite) root.setAttribute("data-readonly", "")
  shadow.append(root)
  const stopTheme = followTheme(host)

  // While the page is one that the options leave out, nothing renders: no pins, no toolbar, and no hotkey.
  const active = shallowRef(options.active)
  const setActive = (value: boolean) => {
    active.value = value
    host.style.display = value ? "" : "none"
  }
  setActive(options.active)

  const subject = shallowRef({ id: options.path(), kind: "page" })
  const edit = shallowRef<EditTarget | null>(null)
  let latest = 0
  const lookup = async (path: string) => {
    const ticket = ++latest
    const found = await resolveDocument(base, path)
    if (ticket === latest) edit.value = found
  }
  const stopTracking = options.subscribe(() => {
    const id = options.path()
    if (id !== subject.value.id) subject.value = { id, kind: "page" }
  })
  // Only an app with Content has `content.resolve`; without it the call would fail with a 404 on every page.
  if (options.edit) watch(() => subject.value.id, id => void lookup(id), { immediate: true })

  const client = createCommentsClient({
    transport: createRpcTransport({ base: prefix }),
    ...(session.user ? { user: session.user } : {}),
  })
  // Subject ids are paths below the app base. The links of the list, and where a row leads, include the base.
  const subjectUrl = (target: { id: string, kind: string }) => target.kind === "page" ? `${prefix}${target.id}` : undefined
  const navigate = (href: string) => globalThis.location.assign(href)

  const Overlay = defineComponent({
    name: "CommentsOverlay",
    setup() {
      return () =>
        active.value
          ? h(CommentLayer, { client, hotkey: session.canWrite ? "c" : false, navigate, subject: subject.value, subjectUrl, ...(session.user ? { user: session.user } : {}) }, {
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
          : null
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
      stopTheme()
      app.unmount()
      host.remove()
    },
    host,
    setActive,
  }
}
