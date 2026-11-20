// @vitest-environment happy-dom

import {
  createCommentsClient,
  createMemoryOutboxStore,
  type CommentCreateInput,
  type CommentFiles,
  type CommentsOutboxEnvironment,
  type CommentsTransport,
  type CommentUser,
} from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { CommentLayer } from "../src/components/comment-layer.ts";
import { CommentPin } from "../src/components/comment-pin.ts";
import { CommentPanel, CommentThread, provideComments, useComments, type CommentStatusSlotScope, type CommentsState } from "../src/index.ts";

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const pricing = { id: "/pricing", kind: "page" };

const UButton = defineComponent({
  setup(_props, { attrs }) {
    return () => h("button", { ...attrs, type: "button" }, typeof attrs.label === "string" ? attrs.label : undefined);
  },
});
const global = { components: { UButton, UIcon: defineComponent({ setup: () => () => h("span") }) } };

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = "";
});

/** A browser with no network until the test turns it on. */
function offlineBrowser() {
  let online = false;
  const listeners = new Set<(event: "online" | "offline" | "visible" | "hidden") => void>();
  const environment: CommentsOutboxEnvironment = {
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isVisible: () => true,
    isOnline: () => online,
    lock: (_name, task) => task(),
    lead(_name, task) {
      const controller = new AbortController();
      void task(controller.signal);
      return () => controller.abort();
    },
    post: () => undefined,
    receive: () => () => undefined,
    schedule: () => () => undefined,
    random: () => 0,
  };
  return {
    environment,
    goOnline() {
      online = true;
      for (const listener of listeners) listener("online");
    },
  };
}

function setup(transport: CommentsTransport = createMemoryTransport({ user: ana, users: [ana] })) {
  const browser = offlineBrowser();
  const client = createCommentsClient({ transport, user: ana, outbox: { account: ana.id, store: createMemoryOutboxStore(), environment: browser.environment } });
  return { browser, client };
}

function mountWithState(client: ReturnType<typeof setup>["client"], render: (state: CommentsState) => ReturnType<typeof h>) {
  let state!: CommentsState;
  const wrapper = mount(defineComponent({
    setup() {
      state = useComments({ client, subject: pricing });
      provideComments(state);
      return () => render(state);
    },
  }), { attachTo: document.body, global });
  mounted.push(wrapper);
  return { wrapper, state: () => state };
}

describe("comments that wait in the outbox", () => {
  it("marks a waiting thread and its messages, and draws the status slot under each one", async () => {
    const { client } = setup();
    const thread = await client.create({ subject: pricing, anchor: { kind: "page" }, body: "The price is wrong" });
    await client.reply({ threadId: thread.id, body: "On the yearly plan too" });
    const seen: CommentStatusSlotScope[] = [];
    const { wrapper } = mountWithState(client, state => h(CommentThread, { thread: state.threads.value.find(item => item.id === thread.id) ?? thread }, {
      status: (scope: CommentStatusSlotScope) => {
        seen.push(scope);
        return [h("span", { class: "waiting" }, `Waiting: ${scope.message.body}`)];
      },
    }));
    await flushPromises();

    const section = wrapper.get("[data-slot='comment-thread']");
    expect(section.attributes("data-pending")).toBe("true");
    expect(section.attributes("data-failed")).toBeUndefined();
    expect(wrapper.get("[data-slot='comment-thread-title']").text()).toBe("Comment");
    const replies = wrapper.findAll("[data-slot='comment-reply']");
    expect(replies.map(reply => reply.attributes("data-pending"))).toEqual(["true", "true"]);
    expect(wrapper.findAll("[data-slot='comment-reply-status']").map(status => status.text())).toEqual(["Waiting: The price is wrong", "Waiting: On the yearly plan too"]);
    expect(seen.at(-1)!.delivery).toMatchObject({ status: "pending" });
  });

  it("draws nothing without the status slot, and nothing for a message that the server has", async () => {
    const { client } = setup();
    const { wrapper } = mountWithState(client, () => h(CommentThread, {
      thread: {
        anchor: { kind: "page" }, author: ana, createdAt: 1, id: "thread-1", n: 4, scope: "site", status: "open", subject: pricing, updatedAt: 1,
        messages: [{ attachments: [], author: ana, body: "Sent", createdAt: 1, id: "message-1", mentions: [], threadId: "thread-1" }],
      },
    }, { status: () => [h("span", "never")] }));
    await flushPromises();
    expect(wrapper.get("[data-slot='comment-thread']").attributes("data-pending")).toBeUndefined();
    expect(wrapper.get("[data-slot='comment-reply']").attributes("data-pending")).toBeUndefined();
    expect(wrapper.find("[data-slot='comment-reply-status']").exists()).toBe(false);
    expect(wrapper.get("[data-slot='comment-thread-title']").text()).toBe("Comment 4");
  });

  it("marks a refused comment as failed, and the slot's retry sends it again", async () => {
    const memory = createMemoryTransport({ user: ana, users: [ana] });
    let refuse = true;
    const transport: CommentsTransport = {
      ...memory,
      create: async (input: CommentCreateInput & CommentFiles) => {
        if (refuse) throw Object.assign(new Error("Too long."), { status: 400, code: "COMMENTS_INVALID_INPUT", why: "Too long." });
        return memory.create(input);
      },
    };
    const { browser, client } = setup(transport);
    const created = await client.create({ subject: pricing, anchor: { kind: "page" }, body: "A very long comment" });
    let retry: CommentStatusSlotScope["retry"];
    const { wrapper, state } = mountWithState(client, current => {
      const thread = current.threads.value.find(item => item.id === created.id || item.requestId === created.requestId);
      return thread
        ? h(CommentThread, { thread }, { status: (scope: CommentStatusSlotScope) => {
            retry = scope.retry;
            return [h("span", scope.delivery.status === "failed" ? `Not sent: ${scope.delivery.error?.why}` : "Waiting")];
          } })
        : h("p", "gone");
    });
    browser.goOnline();
    await vi.waitFor(() => expect(state().outbox.failures.value).toHaveLength(1));
    await flushPromises();
    expect(wrapper.get("[data-slot='comment-thread']").attributes("data-failed")).toBe("true");
    expect(wrapper.get("[data-slot='comment-reply']").attributes("data-failed")).toBe("true");
    expect(wrapper.get("[data-slot='comment-reply-status']").text()).toBe("Not sent: Too long.");
    expect(state().outbox.delivery(created.id)).toMatchObject({ status: "failed", error: { status: 400 } });

    refuse = false;
    expect(retry).toBeTypeOf("function");
    await retry?.();
    await vi.waitFor(() => expect(state().outbox.queued.value).toHaveLength(0));
    await flushPromises();
    expect(wrapper.get("[data-slot='comment-thread']").attributes("data-failed")).toBeUndefined();
    expect(wrapper.find("[data-slot='comment-reply-status']").exists()).toBe(false);
    expect(memory.threads).toHaveLength(1);
  });

  it("lists a waiting thread with no number, marked as the thread is", async () => {
    const { client } = setup();
    await client.create({ subject: pricing, anchor: { kind: "page" }, body: "Waiting row" });
    const { wrapper } = mountWithState(client, state => h(CommentPanel, { comments: state }));
    await flushPromises();
    const row = wrapper.get("[data-slot='comment-panel-item']");
    expect(row.attributes("data-pending")).toBe("true");
    expect(row.attributes("data-failed")).toBeUndefined();
    expect(row.get("[data-slot='comment-list-number']").text()).toBe("");
    expect(row.text()).toContain("Waiting row");
  });

  it("names an unnumbered pin without saying undefined", () => {
    const wrapper = mount(CommentPin, { props: { author: ana, excerpt: "Waiting" } });
    mounted.push(wrapper);
    expect(wrapper.attributes("aria-label")).toBe("Comment by Ana Ruiz: Waiting");
  });

  it.each([{ readOnly: true }, { preview: true }, { can: () => false }])("keeps delivery visible without forbidden actions (%o)", async (restrictions) => {
    const { client } = setup();
    const thread = await client.create({ subject: pricing, anchor: { kind: "page" }, body: "Waiting" });
    const status = vi.fn((scope: CommentStatusSlotScope) => [h("span", scope.delivery.status)]);
    const { wrapper } = mountWithState(client, () => h(CommentThread, { thread, ...restrictions }, { status }));
    await flushPromises();
    expect(wrapper.get("[data-slot='comment-reply-status']").text()).toBe("pending");
    expect(status.mock.lastCall?.[0]).toMatchObject({ retry: undefined, dismiss: undefined, edit: undefined });
  });

  it.each(["panel", "layer"])("keeps the %s reply draft through confirmation and replies to the server ID", async (view) => {
    const memory = createMemoryTransport({ user: ana, users: [ana] });
    const reply = vi.fn(memory.reply);
    const { browser, client } = setup({ ...memory, reply });
    const thread = await client.create({ subject: pricing, anchor: { kind: "page" }, body: "Waiting" });
    const { wrapper, state } = mountWithState(client, current => view === "panel"
      ? h(CommentPanel, { comments: current, thread: thread.id })
      : h(CommentLayer, { comments: current }));
    if (view === "layer") state().open(thread);
    await flushPromises();
    const composer = "[data-slot='comment-thread'] textarea";
    await wrapper.get(composer).setValue("Still writing");

    browser.goOnline();
    await vi.waitFor(() => expect(state().threads.value[0]?.n).toBe(1));
    await flushPromises();
    expect(wrapper.get("[data-slot='comment-thread-title']").text()).toBe("Comment 1");
    expect(wrapper.get<HTMLTextAreaElement>(composer).element.value).toBe("Still writing");
    await wrapper.get("[data-slot='comment-thread'] form").trigger("submit");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith(expect.objectContaining({ threadId: memory.threads[0]?.id, body: "Still writing" })));
  });

  it("does not offer files for a text-only outbox and still sends comments", async () => {
    const memory = createMemoryTransport({ user: ana, users: [ana] });
    const { browser, client } = setup(memory);
    const { wrapper } = mountWithState(client, state => h(CommentPanel, { comments: state }));
    expect(wrapper.find("input[type=file]").exists()).toBe(false);
    await wrapper.get("textarea").setValue("Just text");
    await wrapper.get("form").trigger("submit");
    browser.goOnline();
    await vi.waitFor(() => expect(memory.threads[0]?.messages[0]?.body).toBe("Just text"));
  });

  it("uses the supplied upload callback with an outbox", async () => {
    const memory = createMemoryTransport({ user: ana, users: [ana] });
    const create = vi.fn(memory.create);
    const { browser, client } = setup({ ...memory, create });
    const upload = vi.fn(async (_files: File[]) => ["uploaded-key"]);
    const { wrapper } = mountWithState(client, state => h(CommentPanel, { comments: state, upload, queueFiles: true }));
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    const input = wrapper.get<HTMLInputElement>("input[type=file]").element;
    Object.defineProperty(input, "files", { configurable: true, value: [shot] });
    input.dispatchEvent(new Event("change"));
    await wrapper.get("textarea").setValue("File by key");
    await wrapper.get("form").trigger("submit");
    expect(upload).toHaveBeenCalledWith([shot]);
    browser.goOnline();
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ attachments: ["uploaded-key"] })));
    expect(create.mock.calls[0]?.[0].files).toEqual([]);
  });

  it("empties the composer once the comment is saved, while the server has not answered", async () => {
    const memory = createMemoryTransport({ user: ana, users: [ana] });
    const create = vi.fn((_input: CommentCreateInput & CommentFiles) => new Promise<never>(() => undefined));
    const { browser, client } = setup({ ...memory, create });
    browser.goOnline();
    const { wrapper } = mountWithState(client, state => h(CommentPanel, { comments: state, queueFiles: true }));
    await flushPromises();
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    const input = wrapper.get("input[type=file]").element as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [shot] });
    input.dispatchEvent(new Event("change"));
    await wrapper.get("textarea").setValue("Sent with no answer yet");
    await wrapper.get("form").trigger("submit");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await flushPromises();

    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("");
    expect(create.mock.calls[0]![0]).toMatchObject({ body: "Sent with no answer yet", files: [shot] });
    expect(client.threads).toHaveLength(1);
    expect(client.threads[0]!.delivery).toMatchObject({ status: "pending" });
  });
});
