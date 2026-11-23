// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import type { CommentSendAgent, CommentSendClient, CommentSendState } from "@vite-hub/comments/client";
import { CommentSend } from "../src/index.ts";

const UIcon = defineComponent({ props: { name: String }, setup: (props) => () => h("span", { "data-icon": props.name }) });
const t3: CommentSendAgent = { name: "T3 Code", logo: "t3", host: "relay.t3.codes" };
const retryAt = new Date(2026, 10, 19, 15, 10).getTime();

function stubClient(initial: CommentSendState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const client: CommentSendClient = {
    get state() {
      return state;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn(() => () => {}),
    refresh: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    pairAnother: vi.fn(async () => {}),
    allow: vi.fn(async () => {}),
    copyAgain: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
  const set = (next: CommentSendState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return { client, set };
}

const states: Array<[string, CommentSendState, string]> = [
  ["idle", { status: "idle", count: 2, inbox: false }, "Send2"],
  ["pairing", { status: "pairing", count: 2, prompt: "…", expiresAt: 0, agent: t3 }, "Setup prompt copied. Paste it in the T3 thread that should get your comments"],
  ["confirm", { status: "confirm", count: 2, agent: t3 }, "T3 Code · relay.t3.codes wants your comments from this siteAllow and send 2"],
  ["sending", { status: "sending", count: 2 }, "Sending"],
  ["sent", { status: "sent", count: 0, inbox: false }, "Sent"],
  ["working", { status: "working", count: 0, agent: t3, thread: "https://app.t3.codes/threads/42" }, "WorkingOpen thread"],
  ["failed", { status: "failed", count: 2, reason: "The relay answered 502." }, "Not deliveredRetry"],
  ["limited", { status: "limited", count: 2, retryAt }, "Limit reached, try at 15:10"],
  ["expired", { status: "pairing", count: 2, prompt: "…", expiresAt: 0, agent: t3, reason: "expired" }, "Setup code expiredCopy again"],
  ["refused", { status: "pairing", count: 2, prompt: "…", expiresAt: 0, agent: t3, reason: "refused" }, "That URL isn't relay.t3.codesCopy again"],
  ["inbox", { status: "idle", count: 3, inbox: true }, "To inbox3"],
];

describe("CommentSend", () => {
  it.each(states)("renders %s as the prototype does", (_name, state, text) => {
    const { client } = stubClient(state);
    const send = mount(CommentSend, { global: { components: { UIcon } }, props: { client } });
    expect(send.attributes()).toMatchObject({ "data-slot": "comment-send", "data-state": state.status, role: "group" });
    send.findAll("[data-slot=comment-send-hold-copy]").forEach(copy => copy.element.remove());
    expect(send.text()).toBe(text);
    send.unmount();
  });

  it("starts the client on mount and stops it on unmount", () => {
    const stop = vi.fn();
    const { client } = stubClient({ status: "idle", count: 1, inbox: false });
    vi.mocked(client.start).mockReturnValue(stop);
    const send = mount(CommentSend, { global: { components: { UIcon } }, props: { client } });
    expect(client.start).toHaveBeenCalledOnce();
    send.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("hides Send with nothing to send", () => {
    const { client } = stubClient({ status: "idle", count: 0, inbox: false });
    const send = mount(CommentSend, { global: { components: { UIcon } }, props: { client } });
    expect(send.attributes("hidden")).toBeDefined();
  });

  it("follows the client and passes each press on", async () => {
    const { client, set } = stubClient({ status: "idle", count: 2, inbox: false });
    const send = mount(CommentSend, { attachTo: document.body, global: { components: { UIcon } }, props: { client } });
    expect(send.find("[data-action=send]").attributes("aria-label")).toBe("Send: 2 comments");
    await send.find("[data-action=send]").trigger("click");
    expect(client.send).toHaveBeenCalledOnce();

    set({ status: "confirm", count: 2, agent: t3 });
    await send.vm.$nextTick();
    expect(send.find("[data-logo=t3] path").exists()).toBe(true);
    await send.find("[data-action=allow]").trigger("click");
    expect(client.allow).toHaveBeenCalledOnce();
    await send.find("[data-action=cancel]").trigger("click");
    expect(client.cancel).toHaveBeenCalledOnce();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(client.cancel).toHaveBeenCalledTimes(2);

    set({ status: "pairing", count: 2, prompt: "…", expiresAt: 0, agent: t3, reason: "expired" });
    await send.vm.$nextTick();
    await send.find("[data-action=copy-again]").trigger("click");
    expect(client.copyAgain).toHaveBeenCalledOnce();

    set({ status: "working", count: 1, agent: t3, thread: "https://app.t3.codes/threads/42" });
    await send.vm.$nextTick();
    const open = send.find("a[data-action=open]");
    expect(open.attributes()).toMatchObject({ href: "https://app.t3.codes/threads/42", target: "_blank", "aria-label": "Open the T3 Code thread" });
    expect(send.find("[data-action=send]").text()).toBe("Send1");

    set({ status: "failed", count: 2, reason: "The relay answered 502." });
    await send.vm.$nextTick();
    await send.find("[data-action=retry]").trigger("click");
    expect(client.send).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(client.cancel).toHaveBeenCalledTimes(2);
    send.unmount();
  });

  it("draws Claude and Codex logos for their agents", () => {
    for (const logo of ["claude", "codex"] as const) {
      const { client } = stubClient({ status: "confirm", count: 1, agent: { name: logo, logo, host: "example.com" } });
      const send = mount(CommentSend, { global: { components: { UIcon } }, props: { client } });
      expect(send.find(`[data-logo=${logo}] path`).attributes("d")).toMatch(/^[mM]/);
      send.unmount();
    }
  });
});
