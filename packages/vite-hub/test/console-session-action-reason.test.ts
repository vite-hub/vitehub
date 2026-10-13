import { createRenderer, ssrContextKey } from "vue"
import { describe, expect, it } from "vitest"

import Actions from "../src/console/runtime/components/console-session-actions.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface ActionState {
  rerunLabel: string
}

describe("Console session rerun reason", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("uses a safe fallback for unknown reason %s", (reason) => {
    const app = renderer.createApp({ ...Actions, render: () => null }, {
      agent: "support", agentsBase: "/agents", apiBase: "/api", deletable: false,
      id: "run-1", rerun: { available: false, reason },
    })
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: ActionState }).setupState
      expect(state.rerunLabel).toBe("Rerun is unavailable for this session")
    }
    finally {
      app.unmount()
    }
  })
})
