import { expect, it } from "vitest"

it("limits fragment checks to the current page while checking other pages' responses", async () => {
  // Exercise the installed checker's build-time inspector, including its documented fragment limitation.
  const { inspect } = await import(new URL("./runtime/shared/inspect.js", import.meta.resolve("nuxt-link-checker")).href)
  const context = {
    link: "/guide#missing",
    ids: ["intro"],
    textContent: "Guide",
    siteConfig: { url: "https://docs.example.com", trailingSlash: false },
    response: { status: 200 },
  }

  // /guide exists, but a link from another page does not validate its fragment.
  expect(inspect({ ...context, fromPath: "/" })).toMatchObject({ passes: true, error: [] })
  expect(inspect({ ...context, fromPath: "/guide" })).toMatchObject({
    passes: false,
    error: [{ name: "missing-hash" }],
  })
  expect(inspect({ ...context, fromPath: "/guide", link: "/guide#intro" })).toMatchObject({ passes: true, error: [] })
  expect(inspect({ ...context, fromPath: "/", response: { status: 404 } })).toMatchObject({
    passes: false,
    error: [{ name: "no-error-response" }],
  })
})
