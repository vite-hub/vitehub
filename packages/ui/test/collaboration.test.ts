// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarStack, ConnectionStatus, ConnectionStatusLabel, SyncStatus, SyncStatusLabel } from "../src/index.ts";

const people = [
  { color: "#E11D48", id: "ana", name: "Ana Ruiz" },
  { color: "#2563EB", id: "ben", image: "https://example.com/ben.png", name: "Ben" },
  { color: "#059669", id: "cleo", name: "Cleo" },
  { color: "#7C3AED", id: "dev", name: "Dev" },
];

afterEach(() => vi.useRealTimers());

describe("AvatarStack", () => {
  it("shows each person once and counts the +N item toward max", () => {
    const wrapper = mount(() => h(AvatarStack, { people: [...people, { ...people[0]!, name: "Ana in another tab" }] }));

    const items = wrapper.findAll('[data-slot="avatar-stack-item"]');
    expect(items.map(item => item.attributes("title"))).toEqual(["Ana Ruiz", "Ben"]);
    expect(items[0]!.text()).toBe("AR");
    expect(items[1]!.find('[data-slot="avatar-stack-image"]').attributes("src")).toBe("https://example.com/ben.png");
    const count = wrapper.get('[data-slot="avatar-stack-count"]');
    expect(count.text()).toBe("+2");
    expect(count.attributes("title")).toBe("Cleo, Dev");
    expect(wrapper.get('[data-slot="avatar-stack"]').attributes("aria-label")).toBe("4 people: Ana Ruiz, Ben, Cleo, Dev");
  });

  it("shows everyone with max null, and no count when everyone fits", () => {
    const all = mount(() => h(AvatarStack, { max: null, people }));
    expect(all.findAll('[data-slot="avatar-stack-item"]')).toHaveLength(4);
    expect(all.find('[data-slot="avatar-stack-count"]').exists()).toBe(false);

    const fits = mount(() => h(AvatarStack, { max: 4, people }));
    expect(fits.findAll('[data-slot="avatar-stack-item"]')).toHaveLength(4);
  });

  it("passes each presence color to the outline ring", () => {
    const wrapper = mount(() => h(AvatarStack, { people: people.slice(0, 1), size: "sm", variant: "outline" }));

    const stack = wrapper.get('[data-slot="avatar-stack"]');
    expect(stack.attributes()).toMatchObject({ "data-size": "sm", "data-variant": "outline", role: "group" });
    expect(wrapper.get('[data-slot="avatar-stack-item"]').attributes("style")).toContain("--vh-avatar-color: #E11D48");
  });

  it("renders on the server", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(AvatarStack, { people }) }));
    expect(html).toContain('data-slot="avatar-stack-count"');
  });
});

describe("ConnectionStatus", () => {
  it("connects, stays connected through a short drop, and shows reconnecting after the delay", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ConnectionStatus, { props: { status: "connecting" } });
    const state = () => wrapper.get('[data-slot="connection-status"]').attributes("data-status");
    expect(state()).toBe("connecting");
    expect(wrapper.get('[data-slot="connection-status-label"]').text()).toBe("Connecting");

    await wrapper.setProps({ status: "connected" });
    expect(state()).toBe("connected");

    await wrapper.setProps({ status: "disconnected" });
    vi.advanceTimersByTime(1_000);
    await nextTick();
    expect(state()).toBe("connected");
    await wrapper.setProps({ status: "connecting" });
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(state()).toBe("reconnecting");
    expect(wrapper.get('[data-slot="connection-status-indicator"]').attributes("data-status")).toBe("reconnecting");
    expect(wrapper.get('[data-slot="connection-status-label"]').attributes("data-status")).toBe("reconnecting");

    await wrapper.setProps({ status: "connected" });
    expect(state()).toBe("connected");
  });

  it("lets the label slot name the state", () => {
    const wrapper = mount(() =>
      h(ConnectionStatus, { status: "connected" }, () => h(ConnectionStatusLabel, null, { default: ({ state }: { state: string }) => (state === "connected" ? "Live" : state) })),
    );
    expect(wrapper.text()).toBe("Live");
    expect(wrapper.find('[data-slot="connection-status-indicator"]').exists()).toBe(false);
  });
});

describe("SyncStatus", () => {
  it.each([
    ["loading", "Loading"],
    ["synchronizing", "Saving"],
    ["synchronized", "Saved"],
    ["error", "Not saved"],
  ] as const)("labels %s as %s", (status, label) => {
    const wrapper = mount(SyncStatus, { props: { status } });
    expect(wrapper.get('[data-slot="sync-status"]').attributes()).toMatchObject({ "data-status": status, role: "status" });
    expect(wrapper.get('[data-slot="sync-status-indicator"]').attributes("data-status")).toBe(status);
    expect(wrapper.get('[data-slot="sync-status-label"]').attributes("data-status")).toBe(status);
    expect(wrapper.get('[data-slot="sync-status-label"]').text()).toBe(label);
  });

  it("lets the label slot add details such as the save time", () => {
    const wrapper = mount(() =>
      h(SyncStatus, { status: "synchronized" }, () => h(SyncStatusLabel, null, { default: () => "Saved 2 min ago" })),
    );
    expect(wrapper.text()).toBe("Saved 2 min ago");
  });
});
