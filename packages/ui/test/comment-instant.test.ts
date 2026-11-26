// @vitest-environment happy-dom

import {
  createCommentsClient,
  createMemoryOutboxStore,
  type CommentCreateInput,
  type CommentFiles,
  type CommentsOutboxEnvironment,
  type CommentsOutboxStore,
  type CommentThread as CommentThreadModel,
  type CommentUser,
} from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { CommentLayer } from "../src/components/comment-layer.ts";
import { provideComments, useComments, type CommentStatusSlotScope, type CommentsState } from "../src/index.ts";

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const pricing = { id: "/pricing", kind: "page" };

const UButton = defineComponent({
  setup(_props, { attrs, slots }) {
    return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? (typeof attrs.label === "string" ? attrs.label : undefined));
  },
});
const global = { components: { UButton, UIcon: defineComponent({ setup: () => () => h("span") }) } };

const mounted: VueWrapper[] = [];
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 200, 40));
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const offline: CommentsOutboxEnvironment = {
  listen: () => () => undefined,
  isVisible: () => true,
  isOnline: () => false,
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

function heldStore() {
  const memory = createMemoryOutboxStore();
  const puts: Array<{ release: () => void; reject: (cause: Error) => void }> = [];
  const store: CommentsOutboxStore = {
    persisted: true,
    list: account => memory.list(account),
    update: (account, change) => new Promise((resolve, reject) => {
      puts.push({ release: () => void memory.update(account, change).then(resolve, reject), reject });
    }),
  };
  return { store, puts };
}

function setup() {
  const { store, puts } = heldStore();
  const memory = createMemoryTransport({ user: ana, users: [ana] });
  const create = vi.fn((_input: CommentCreateInput & CommentFiles) => new Promise<CommentThreadModel>(() => undefined));
  const client = createCommentsClient({ transport: { ...memory, create }, user: ana, outbox: { account: ana.id, store, environment: offline } });
  let state!: CommentsState;
  const wrapper = mount(defineComponent({
    setup() {
      state = useComments({ client, subject: pricing });
      provideComments(state);
      return () => h(CommentLayer, { comments: state }, {
        status: (scope: CommentStatusSlotScope) => scope.delivery.status === "failed"
          ? [h("span", { class: "not-sent" }, "Not sent"), h("button", { class: "retry", onClick: () => scope.retry?.() }, "Retry")]
          : [h("span", "Waiting")],
      });
    },
  }), { attachTo: document.body, global });
  mounted.push(wrapper);
  return { client, create, puts, wrapper, state: () => state };
}

function target(name: string) {
  const element = document.createElement("p");
  element.id = name;
  element.textContent = name;
  document.body.append(element);
  return element;
}

async function write(wrapper: VueWrapper, text: string) {
  await wrapper.get("[data-draft=true] textarea").setValue(text);
  wrapper.get("[data-draft=true] form").element.dispatchEvent(new Event("submit", { cancelable: true }));
}

const pins = (wrapper: VueWrapper) => wrapper.findAll("[data-slot='comment-pin'][data-thread-id]");

describe("instant comments in the layer", () => {
  it("closes the draft on Send, shows the pending pin, takes the next comment at once, and keeps a failed one for Retry", async () => {
    const { client, create, puts, wrapper, state } = setup();
    await flushPromises();

    state().startDraft(target("first"), { point: { x: 40, y: 40 } });
    await nextTick();
    await write(wrapper, "The first one");
    expect(state().draft.value).toBeNull();
    state().startDraft(target("second"), { point: { x: 400, y: 400 } });
    expect(state().draft.value).toMatchObject({ body: "", busy: false });
    await nextTick();
    expect(pins(wrapper)).toHaveLength(1);
    expect(pins(wrapper)[0]!.attributes("data-pending")).toBe("true");
    expect(wrapper.find("[data-draft=true] textarea").exists()).toBe(true);
    await write(wrapper, "The second one");
    expect(state().draft.value).toBeNull();
    await nextTick();
    expect(wrapper.find("[data-draft=true]").exists()).toBe(false);
    expect(pins(wrapper).map(pin => pin.attributes("data-pending"))).toEqual(["true", "true"]);
    expect(client.outbox!.entries.map(entry => entry.input.body)).toEqual(["The first one", "The second one"]);
    expect(create).not.toHaveBeenCalled();

    puts[0]!.reject(new Error("The disk is full."));
    await flushPromises();
    const first = client.outbox!.entries.find(entry => entry.input.body === "The first one")!;
    expect(first.status).toBe("failed");
    const failedPin = wrapper.get(`[data-slot='comment-pin'][data-thread-id='${first.id}']`);
    expect(failedPin.attributes("data-failed")).toBe("true");
    expect(pins(wrapper).filter(pin => pin.attributes("data-pending") === "true")).toHaveLength(1);

    await failedPin.trigger("click");
    await flushPromises();
    const thread = wrapper.get("[data-slot='comment-thread']:not([data-preview])");
    expect(thread.text()).toContain("The first one");
    expect(thread.get(".not-sent").text()).toBe("Not sent");
    await thread.get(".retry").trigger("click");
    await flushPromises();
    expect(client.outbox!.entries.find(entry => entry.id === first.id)?.status).toBe("pending");
    expect(puts).toHaveLength(3);
  });
});
