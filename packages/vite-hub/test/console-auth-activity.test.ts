import { createRenderer, nextTick, ssrContextKey } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { expect, it, vi } from "vitest";
import type { AuthConsoleActivity } from "@vite-hub/auth/console";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/console/runtime/client/auth-management", () => ({ readAuthConsole: mocks.read }));
import Activity from "../src/console/runtime/components/console-auth-activity.vue";

const renderer = createRenderer({
  createComment: () => ({}),
  createElement: () => ({}),
  createText: () => ({}),
  insert() {},
  nextSibling: () => null,
  parentNode: () => null,
  patchProp() {},
  remove() {},
  setElementText() {},
  setText() {},
});

it("keeps cursor filters, resets on a new user and ignores stale responses", async () => {
  const pending: Array<(value: AuthConsoleActivity) => void> = [];
  mocks.read.mockReset().mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ name: "vitehub-console-auth", path: "/auth/:page?", component: {} }],
  });
  await router.push("/auth/activity?group=admin&userId=u1");
  const app = renderer.createApp(
    { ...Activity, render: () => null },
    { base: "/manage", enabled: true, revision: 0 },
  );
  app.use(router);
  app.provide(ssrContextKey, {});
  const instance = app.mount({});
  const state = (
    instance.$ as unknown as {
      setupState: {
        data?: AuthConsoleActivity;
        page: number;
        loading: boolean;
        next(): void;
        previous(): void;
      };
    }
  ).setupState;
  try {
    pending[0]!({ enabled: true, events: [], nextCursor: "cursor-a" });
    await vi.waitFor(() => expect(state.loading).toBe(false));
    state.next();
    expect(mocks.read.mock.lastCall?.[2]).toEqual({
      activity: { group: "admin", userId: "u1", cursor: "cursor-a", limit: 25 },
    });
    await router.replace("/auth/activity?group=agents&userId=u2");
    await nextTick();
    expect(state.page).toBe(0);
    const current = { enabled: true, events: [], nextCursor: "cursor-b" };
    pending[2]!(current);
    await vi.waitFor(() => expect(state.data).toEqual(current));
    pending[1]!({ enabled: true, events: [], nextCursor: "stale" });
    await nextTick();
    expect(state.data).toEqual(current);
    state.next();
    pending[3]!({ enabled: true, events: [] });
    await vi.waitFor(() => expect(state.loading).toBe(false));
    state.previous();
    expect(mocks.read.mock.lastCall?.[2]).toEqual({
      activity: { group: "agents", userId: "u2", cursor: undefined, limit: 25 },
    });
    app.unmount();
    expect(mocks.read.mock.lastCall?.[3].aborted).toBe(true);
  } finally {
    app.unmount();
  }
});

it("does not request activity when the event store is disabled", async () => {
  mocks.read.mockReset();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: {} }],
  });
  await router.push("/");
  const app = renderer.createApp(
    { ...Activity, render: () => null },
    { base: "/manage", enabled: false, revision: 0 },
  );
  app.use(router);
  app.provide(ssrContextKey, {});
  app.mount({});
  expect(mocks.read).not.toHaveBeenCalled();
  app.unmount();
});
