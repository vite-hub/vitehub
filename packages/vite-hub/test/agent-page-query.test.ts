// @vitest-environment happy-dom
import { createAgent } from "@ui-sdk/core/agent"
import { tabs } from "@ui-sdk/core/tabs"
import { mount } from "@ui-sdk/core/testing"
import { connectPage } from "@vite-hub/agent/page"
import { expect, it, vi } from "vitest"

it("does not switch tabs on a Page Agent query", async () => {
  const onValueChange = vi.fn()
  const settings = mount(tabs, { defaultValue: "profile", onValueChange }, `
    <root aria-label="Settings">
      <list><tab value="profile">Profile</tab><tab value="billing">Billing</tab></list>
      <panel value="profile"></panel><panel value="billing"></panel>
    </root>
  `)
  let request: ((body: unknown) => unknown) | undefined
  const page = connectPage(createAgent, {
    join: () => ({
      onRequest: (handler) => {
        request = handler
        return () => {}
      },
      onUpdate: () => () => {},
      status: () => "connected",
      destroy: () => {},
    }),
  })
  const rules = { deny: [{ component: "tabs" }], requireApproval: [] }
  try {
    expect(await request?.({ method: "query", input: { kind: "tabs" }, rules })).toEqual([
      expect.objectContaining({ component: "tabs", value: "profile" }),
    ])
    const discovery = await request?.({ method: "query", input: { closed: true, kind: "tabs" }, rules })
    expect(onValueChange).not.toHaveBeenCalled()
    expect(discovery).toEqual({ error: "page_query does not open closed tabs or sections." })
    expect(settings.state.value).toBe("profile")
  } finally {
    page.close()
    settings.unmount()
  }
})
