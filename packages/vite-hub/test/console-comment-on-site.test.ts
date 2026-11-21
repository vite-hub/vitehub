import { afterEach, expect, it } from "vitest"

import { commentOnSiteUrl } from "../src/console/runtime/client/comment-on-site.ts"
import { consoleProject, setConsoleProject } from "../src/console/runtime/client/project.ts"

const pageProject = consoleProject()

afterEach(() => {
  setConsoleProject(pageProject)
})

it("opens the app's home page in comment mode on the Console's own origin", () => {
  expect(commentOnSiteUrl()).toBe("/?vitehub=comments")
  expect(commentOnSiteUrl("/pricing")).toBe("/pricing?vitehub=comments")
})

it("opens the app of an account Console, not the Console server that forwards its requests", () => {
  setConsoleProject({ origin: "", base: "/p/acme", app: { origin: "https://acme.example", base: "/portal" }, remote: true })
  expect(commentOnSiteUrl()).toBe("https://acme.example/portal/?vitehub=comments")
  // A thread's page is the full path that the browser had, with the base.
  expect(commentOnSiteUrl("/portal/pricing")).toBe("https://acme.example/portal/pricing?vitehub=comments")
})

it.each(["pricing", "//evil.example/x", "/\\evil.example", "/a b", "/pricing?plan=pro", "/pricing#faq"])("gives no link for %j, which is not an app path", (page) => {
  expect(commentOnSiteUrl(page)).toBeUndefined()
})
