import type { CommentComponent, CommentContext } from "../types.ts"

/** The few members of a Vue vnode that a production build keeps and the walk reads. */
interface VNodeLike {
  el?: unknown
  component?: { type?: { __name?: unknown, name?: unknown }, subTree?: VNodeLike } | null
  children?: unknown
  suspense?: { activeBranch?: VNodeLike | null } | null
}

interface VueContainer extends Element {
  _vnode?: VNodeLike
  __vue_app__?: { config?: { globalProperties?: { $router?: { currentRoute?: { value?: { matched?: Array<{ path?: unknown }> } } } } } }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The server adds the files: a production build keeps only the name, and the browser may not name files. */
function componentOf(type: NonNullable<VNodeLike["component"]>["type"]): CommentComponent | undefined {
  const name = text(type?.__name) ?? text(type?.name)
  return name ? { name } : undefined
}

/** Vue app roots on the page. Each keeps `__vue_app__` and its root vnode in production builds. */
function vueContainers(): VueContainer[] {
  const roots: VueContainer[] = []
  for (const element of document.querySelectorAll<VueContainer>("[data-v-app], #__nuxt, #app")) {
    if (element._vnode) roots.push(element)
  }
  return roots
}

/**
 * The Vue components that render an element, outermost first. Production builds keep the root vnode on the app
 * container and each component's subtree, so the walk works without Vue devtools. Pages without Vue get `[]`.
 */
export function vueComponentsOf(target: Element): CommentComponent[] {
  const found = new Map<unknown, CommentComponent[]>()
  const visit = (node: unknown, stack: CommentComponent[], depth: number) => {
    if (!node || typeof node !== "object" || depth > 4000) return
    // SAFETY: the walk only reads optional vnode members and checks each one.
    const vnode = node as VNodeLike
    if (vnode.component) {
      const component = componentOf(vnode.component.type)
      visit(vnode.component.subTree, component ? [...stack, component] : stack, depth + 1)
      return
    }
    if (vnode.el && !found.has(vnode.el)) found.set(vnode.el, stack)
    if (vnode.suspense?.activeBranch) visit(vnode.suspense.activeBranch, stack, depth + 1)
    if (Array.isArray(vnode.children)) for (const child of vnode.children) visit(child, stack, depth + 1)
  }
  for (const container of vueContainers()) visit(container._vnode, [], 0)
  for (let element: Element | null = target; element; element = element.parentElement) {
    const stack = found.get(element)
    if (stack) return stack.slice(-12)
  }
  return []
}

/** The route pattern of the Vue Router of the page, such as `/blog/:id(.*)*`. */
function routeOf(): string | undefined {
  for (const container of vueContainers()) {
    const matched = container.__vue_app__?.config?.globalProperties?.$router?.currentRoute?.value?.matched
    const path = matched?.length ? text(matched.at(-1)?.path) : undefined
    if (path) return path
  }
}

const implicitRoles: Record<string, string> = { a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading", img: "img", input: "textbox", nav: "navigation", select: "combobox", textarea: "textbox" }

function elementOf(element: Element): NonNullable<CommentContext["element"]> {
  const tag = element.tagName.toLowerCase()
  const result: NonNullable<CommentContext["element"]> = { tag }
  if (element.id) result.id = element.id.slice(0, 128)
  const testId = element.closest("[data-testid], [data-test], [data-cy]")
  const testValue = testId?.getAttribute("data-testid") ?? testId?.getAttribute("data-test") ?? testId?.getAttribute("data-cy")
  if (testValue) result.testId = testValue.slice(0, 128)
  const role = element.getAttribute("role") ?? implicitRoles[tag]
  if (role) result.role = role.slice(0, 64)
  const name = element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.getAttribute("title") ?? element.textContent?.replace(/\s+/g, " ").trim()
  if (name) result.name = name.slice(0, 120)
  const classes = [...element.classList].slice(0, 8).map(value => value.slice(0, 64))
  if (classes.length) result.classes = classes
  return result
}

/** The page, element, components, and browser of a new thread. The server adds the build. */
export function captureContext(element: Element | undefined): CommentContext {
  const url = new URL(location.href)
  const context: CommentContext = {
    url: `${url.origin}${url.pathname}`.slice(0, 2048),
    environment: {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio: devicePixelRatio,
      userAgent: navigator.userAgent.slice(0, 512),
      language: navigator.language,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  }
  if (document.title) context.title = document.title.slice(0, 256)
  const route = routeOf()
  if (route) context.route = route.slice(0, 256)
  if (element) {
    context.element = elementOf(element)
    const components = vueComponentsOf(element)
    if (components.length) context.components = components
  }
  return context
}
