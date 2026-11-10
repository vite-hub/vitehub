import { expect, it } from "vitest"

import { appPathname } from "../src/console/page/app-path.ts"

it("takes the app base and trailing slashes off the page path", () => {
  expect(appPathname("/pricing", "/")).toBe("/pricing")
  expect(appPathname("/pricing/", "/")).toBe("/pricing")
  expect(appPathname("/", "/")).toBe("/")
  expect(appPathname("/portal/pricing", "/portal/")).toBe("/pricing")
  expect(appPathname("/portal/pricing/", "/portal/")).toBe("/pricing")
  expect(appPathname("/portal", "/portal/")).toBe("/")
  expect(appPathname("/portal/", "/portal/")).toBe("/")
  expect(appPathname("/portalx", "/portal/")).toBe("/portalx")
  expect(appPathname("/other", "/portal/")).toBe("/other")
})
