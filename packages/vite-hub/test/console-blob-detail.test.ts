import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it, vi } from "vitest"

vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ error: vi.fn(), show: vi.fn() }) }))
vi.mock("../src/console/runtime/components/console-property-list.vue", () => ({ default: { render: () => null } }))
vi.mock("../src/console/runtime/components/console-relative-time.vue", () => ({ default: { render: () => null } }))

import BlobDetail from "../src/console/runtime/components/console-blob-detail.vue"

it("shows the whole pathname and wraps it after each slash", async () => {
  const pathname = "screenshots/console-empty-states/kv-dark.png"
  const app = createSSRApp(BlobDetail, {
    file: { contentType: "image/png", createdAt: "2026-08-30T12:00:00Z", name: "kv-dark.png", pathname, size: 10 },
    store: "default",
  })
  for (const name of ["UButton", "UIcon", "UTooltip"]) app.component(name, { render: () => null })
  const html = await renderToString(app)
  const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? ""
  expect(code.replace(/<[^>]+>/g, "")).toBe(pathname)
  expect([...code.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(match => match[1])).toEqual(["screenshots/", "console-empty-states/", "kv-dark.png"])
  expect(html).not.toContain("truncate text-xs")
})
