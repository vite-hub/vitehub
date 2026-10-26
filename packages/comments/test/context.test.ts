// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"

import { describeCommentContext } from "../src/context.ts"
import { captureContext, vueComponentsOf } from "../src/overlay/context.ts"

/** The vnode tree that a production Vue build keeps: the root vnode on the container, and each component's subtree. */
function mountFakeVue() {
  document.body.innerHTML = `<div id="__nuxt"><main><section class="card pro" data-testid="plan"><button aria-label="Buy Pro">Buy</button></section></main></div>`
  const container = document.querySelector("#__nuxt")!
  const main = container.querySelector("main")!
  const section = container.querySelector("section")!
  const button = container.querySelector("button")!
  Object.assign(container, {
    _vnode: {
      component: {
        type: { name: "App" },
        subTree: {
          el: main,
          children: [{
            component: { type: { __name: "PricingCard" }, subTree: { el: section, children: [{ el: button, children: "Buy" }] } },
          }],
        },
      },
    },
    __vue_app__: { config: { globalProperties: { $router: { currentRoute: { value: { matched: [{ path: "/" }, { path: "/pricing" }] } } } } } },
  })
  return { button, main }
}

describe("page context", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
  })

  it("finds the Vue components of an element, outermost first, in a production build", () => {
    const { button, main } = mountFakeVue()
    expect(vueComponentsOf(button)).toEqual([{ name: "App" }, { name: "PricingCard" }])
    expect(vueComponentsOf(main)).toEqual([{ name: "App" }])
  })

  it("gives no components on a page that Vue does not render", () => {
    document.body.innerHTML = "<p>Plain</p>"
    expect(vueComponentsOf(document.querySelector("p")!)).toEqual([])
  })

  it("reads the page, route, element, and browser, without the comment mode query", () => {
    const { button } = mountFakeVue()
    history.replaceState(null, "", "/pricing?plan=pro&comments#comment-1")
    document.title = "Pricing"
    const context = captureContext(button, "comments")
    expect(context).toMatchObject({
      title: "Pricing",
      route: "/pricing",
      element: { tag: "button", role: "button", name: "Buy Pro", testId: "plan" },
      components: [{ name: "App" }, { name: "PricingCard" }],
      environment: { viewport: { width: innerWidth, height: innerHeight } },
    })
    expect(context.url).toMatch(/\/pricing\?plan=pro$/)
  })

  it("describes a context for the Console and Agents", () => {
    expect(describeCommentContext({
      url: "https://site.test/pricing",
      route: "/pricing",
      element: { tag: "button", role: "button", name: "Buy" },
      components: [{ name: "App" }, { name: "PricingCard", files: ["app/components/PricingCard.vue"] }],
      environment: { viewport: { width: 1280, height: 800 }, devicePixelRatio: 2, userAgent: "Test", colorScheme: "dark" },
      build: { commit: "0123456789abcdef", branch: "main" },
    })).toEqual([
      { label: "URL", value: "https://site.test/pricing" },
      { label: "Route", value: "/pricing" },
      { label: "Element", value: "<button> role button \"Buy\"" },
      { label: "Components", value: "App › PricingCard" },
      { label: "Files", value: "app/components/PricingCard.vue" },
      { label: "Viewport", value: "1280×800 at 2x, dark" },
      { label: "Browser", value: "Test" },
      { label: "Build", value: "main @ 0123456789ab" },
    ])
    expect(describeCommentContext(null)).toEqual([])
  })
})
