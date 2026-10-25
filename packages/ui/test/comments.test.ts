// @vitest-environment happy-dom

import {
  createCommentsClient,
  createMemoryTransport,
  type CommentThread as CommentThreadModel,
  type CommentUser,
} from "@vite-hub/comments/client";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import {
  CommentFilters,
  CommentLayer,
  CommentList,
  CommentToolbar,
  useComments,
} from "../src/index.ts";

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const ben: CommentUser = { id: "ben", name: "Ben Soto" };
const pricing = { id: "/pricing", kind: "page" };
const about = { id: "/about", kind: "page" };

const UButton = defineComponent({
  setup(_props, { attrs }) {
    return () => h("button", { ...attrs, type: "button" }, typeof attrs.label === "string" ? attrs.label : undefined);
  },
});
const global = { components: { UButton, UIcon: defineComponent({ setup: () => () => h("span") }) } };

// happy-dom has no layout, so the page says where the button is.
const rect = { height: 40, left: 100, top: 100, width: 200 };
let target: HTMLElement;
const mounted: VueWrapper[] = [];

beforeEach(() => {
  document.body.innerHTML = `<main><button id="cta">Buy</button></main>`;
  target = document.getElementById("cta")!;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this === target ? rect : { height: 0, left: 0, top: 0, width: 0 };
    return { ...box, bottom: box.top + box.height, right: box.left + box.width, toJSON: () => box, x: box.left, y: box.top };
  });
  document.elementsFromPoint = () => [target, document.body];
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function thread(n: number, patch: Partial<CommentThreadModel> = {}): CommentThreadModel {
  const id = `thread-${n}`;
  return {
    anchor: { kind: "element", selector: "#cta", x: 500, y: 500 },
    author: ana,
    createdAt: 1_000,
    id,
    messages: [{ author: ana, body: `Comment ${n}`, createdAt: 1_000, attachments: [], id: `message-${n}`, mentions: [], threadId: id }],
    n,
    scope: "site",
    status: "open",
    subject: pricing,
    updatedAt: 1_000,
    ...patch,
  };
}

function setup(threads: CommentThreadModel[] = [], user: CommentUser = ana) {
  const transport = createMemoryTransport({ threads, user, users: [ana, ben] });
  const client = createCommentsClient({ transport, user });
  return { client, transport };
}

async function layer(threads: CommentThreadModel[] = [], props: Record<string, unknown> = {}) {
  const { client, transport } = setup(threads);
  const wrapper = mount(CommentLayer, { attachTo: document.body, global, props: { client, subject: pricing, ...props } });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(client.status).toBe("ready"));
  await flushPromises();
  return { client, transport, wrapper };
}

const press = (key: string, init: KeyboardEventInit = {}, on: EventTarget = document) =>
  on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));

async function drop(wrapper: VueWrapper) {
  press("c");
  await flushPromises();
  await wrapper.get("[data-slot=comment-layer-overlay]").trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
  await flushPromises();
}

const composer = (wrapper: VueWrapper) => wrapper.get("[data-slot=comment-composer]");
const textarea = (wrapper: VueWrapper) => wrapper.get("textarea");

describe("comment mode", () => {
  it("toggles with C and shows the comment cursor layer", async () => {
    const { wrapper } = await layer();
    const root = wrapper.get("[data-slot=comment-layer]");
    expect(wrapper.find("[data-slot=comment-layer-overlay]").exists()).toBe(false);

    press("c");
    await flushPromises();
    expect(root.attributes("data-active")).toBe("true");
    expect(wrapper.find("[data-slot=comment-layer-overlay]").exists()).toBe(true);
    expect(wrapper.get("[data-slot=comment-toolbar-mode]").attributes("aria-pressed")).toBe("true");

    press("c");
    await flushPromises();
    expect(root.attributes("data-active")).toBeUndefined();
  });

  it("toggles with the toolbar button", async () => {
    const { wrapper } = await layer();
    await wrapper.get("[data-slot=comment-toolbar-mode]").trigger("click");
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("ignores C while someone types in a field", async () => {
    const { wrapper } = await layer();
    const field = document.createElement("input");
    document.body.append(field);
    press("c", {}, field);
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();
  });

  it("drops a numbered pin with the avatar and focuses the composer", async () => {
    const { wrapper } = await layer([thread(4)]);
    await drop(wrapper);

    const pin = wrapper.get("[data-slot=comment-pin][data-draft=true]");
    expect(pin.get("[data-slot=comment-pin-number]").text()).toBe("5");
    expect(pin.get("[data-slot=avatar-stack-fallback]").text()).toBe("AR");
    expect(wrapper.get("[data-draft=true][data-slot=comment-layer-item]").attributes("style")).toContain("left: 150px");
    expect(wrapper.get("[data-draft=true][data-slot=comment-layer-item]").attributes("style")).toContain("top: 120px");
    expect(document.activeElement).toBe(textarea(wrapper).element);
  });

  it("sends with Enter, keeps the line break for Shift+Enter, and stays in comment mode", async () => {
    const { client, wrapper } = await layer();
    await drop(wrapper);

    await textarea(wrapper).setValue("Make this bigger");
    await textarea(wrapper).trigger("keydown", { key: "Enter", shiftKey: true });
    await flushPromises();
    expect(client.threads).toHaveLength(0);

    await textarea(wrapper).trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads).toHaveLength(1));
    await flushPromises();

    expect(client.threads[0]).toMatchObject({
      anchor: { kind: "element", selector: "#cta", x: 250, y: 500 },
      messages: [{ author: ana, body: "Make this bigger" }],
      n: 1,
      subject: pricing,
    });
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
    expect(wrapper.find("[data-slot=comment-pin][aria-label='Comment 1']").exists()).toBe(true);
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("does not send an empty comment", async () => {
    const { client, wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("   ");
    await textarea(wrapper).trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(client.threads).toHaveLength(0);
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(true);
  });

  it("closes the composer on Esc when it is empty, and stays in comment mode", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);

    await textarea(wrapper).trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("shakes the composer on Esc when it has text, and keeps the focus and the text", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("Half a thought");

    await textarea(wrapper).trigger("keydown", { key: "Escape" });
    await flushPromises();

    expect(composer(wrapper).attributes("data-shake")).toBe("shake");
    expect((textarea(wrapper).element as HTMLTextAreaElement).value).toBe("Half a thought");
    expect(document.activeElement).toBe(textarea(wrapper).element);
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("flashes the border instead of shaking under prefers-reduced-motion", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("Half a thought");

    await textarea(wrapper).trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(composer(wrapper).attributes("data-shake")).toBe("flash");
    expect((textarea(wrapper).element as HTMLTextAreaElement).value).toBe("Half a thought");
  });

  it("shakes on a click outside when there is a draft, and drops no new pin", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("Keep me");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(composer(wrapper).attributes("data-shake")).toBe("shake");
    expect((textarea(wrapper).element as HTMLTextAreaElement).value).toBe("Keep me");
    expect(wrapper.findAll("[data-slot=comment-composer]")).toHaveLength(1);
  });

  it("closes an empty composer on a click outside", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
  });

  it("leaves comment mode on Esc outside a composer", async () => {
    const { wrapper } = await layer();
    press("c");
    await flushPromises();

    press("Escape");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();
  });

  it("keeps a draft with text when Esc comes from outside the composer", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("Keep me");

    press("Escape", {}, document.body);
    await flushPromises();
    expect(composer(wrapper).attributes("data-shake")).toBe("shake");
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("shows a failed send in the composer and keeps the text", async () => {
    const { client, wrapper } = await layer();
    client.create = () => Promise.reject(new Error("You cannot comment here."));
    await drop(wrapper);
    await textarea(wrapper).setValue("Hello");
    await textarea(wrapper).trigger("keydown", { key: "Enter" });
    await flushPromises();

    expect(wrapper.get("[data-slot=comment-composer-error]").text()).toBe("You cannot comment here.");
    expect((textarea(wrapper).element as HTMLTextAreaElement).value).toBe("Hello");
  });
});

describe("mentions", () => {
  it("suggests people after @, inserts the pick, and sends the id", async () => {
    const { client, wrapper } = await layer();
    await drop(wrapper);

    const field = textarea(wrapper);
    await field.setValue("Hi @be");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(true));
    expect(wrapper.findAll("[data-slot=comment-composer-mention]").map((item) => item.text())).toEqual(["Ben Soto"]);

    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((field.element as HTMLTextAreaElement).value).toBe("Hi @Ben Soto ");
    expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(false);
    // The pick did not send the comment.
    expect(client.threads).toHaveLength(0);

    await field.setValue("Hi @Ben Soto please look");
    await field.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads).toHaveLength(1));
    expect(client.threads[0]!.messages[0]!.mentions).toEqual(["ben"]);
  });

  it("closes the menu on Esc without closing the composer", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);
    await textarea(wrapper).setValue("@a");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(true));

    await textarea(wrapper).trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(false);
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(true);
  });
});

describe("pins and threads", () => {
  it("places a pin on its element, and hides threads that are detached or on another page", async () => {
    const { wrapper } = await layer([
      thread(1),
      thread(2, { anchor: { kind: "element", selector: "#gone", x: 0, y: 0 } }),
      thread(3, { subject: about }),
      thread(4, { anchor: { kind: "page" } }),
    ]);

    const pins = wrapper.findAll("[data-slot=comment-pin]");
    expect(pins.map((pin) => pin.attributes("aria-label"))).toEqual(["Comment 1"]);
    expect(wrapper.get("[data-slot=comment-layer-item]").attributes("style")).toContain("left: 200px");
  });

  it("previews a thread on hover and opens it on click", async () => {
    const { wrapper } = await layer([thread(1, { messages: [...thread(1).messages, { ...thread(1).messages[0]!, body: "A reply", id: "reply-1" }] })]);
    const pin = wrapper.get("[data-slot=comment-pin]");

    await pin.trigger("pointerenter");
    const preview = wrapper.get("[data-slot=comment-layer-popover][data-preview=true]");
    expect(preview.text()).toContain("Comment 1");
    expect(preview.text()).toContain("1 reply");
    expect(wrapper.find("[data-slot=comment-thread]:not([data-preview])").exists()).toBe(false);

    await pin.trigger("pointerleave");
    expect(wrapper.find("[data-slot=comment-layer-popover]").exists()).toBe(false);

    await pin.trigger("click");
    const open = wrapper.get("[data-slot=comment-thread]:not([data-preview])");
    expect(open.attributes("role")).toBe("dialog");
    expect(open.text()).toContain("Comment 1");
    expect(open.text()).toContain("A reply");
    expect(pin.attributes("aria-expanded")).toBe("true");
  });

  it("replies, edits its own message, and deletes it", async () => {
    const { client, wrapper } = await layer([thread(1)]);
    await wrapper.get("[data-slot=comment-pin]").trigger("click");

    const field = wrapper.get("[data-slot=comment-thread] [data-variant=reply] textarea");
    await field.setValue("Thanks");
    await field.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads[0]!.messages).toHaveLength(2));
    await flushPromises();
    expect(wrapper.findAll("[data-slot=comment-reply]")).toHaveLength(2);
    expect((field.element as HTMLTextAreaElement).value).toBe("");

    const replies = wrapper.findAll("[data-slot=comment-reply]");
    await replies[1]!.get("[aria-label=Edit]").trigger("click");
    const editor = replies[1]!.get("textarea");
    await editor.setValue("Thanks a lot");
    await editor.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads[0]!.messages[1]!.body).toBe("Thanks a lot"));
    await flushPromises();
    expect(wrapper.findAll("[data-slot=comment-reply]")[1]!.text()).toContain("edited");

    await wrapper.findAll("[data-slot=comment-reply]")[1]!.get("[aria-label=Delete]").trigger("click");
    await vi.waitFor(() => expect(client.threads[0]!.messages).toHaveLength(1));
  });

  it("offers no edit or delete on the messages of other people", async () => {
    const { wrapper } = await layer([thread(1, { author: ben, messages: [{ ...thread(1).messages[0]!, author: ben }] })]);
    await wrapper.get("[data-slot=comment-pin]").trigger("click");
    expect(wrapper.find("[aria-label=Edit]").exists()).toBe(false);
    expect(wrapper.find("[aria-label=Delete]").exists()).toBe(false);
  });

  it("resolves a thread, hides its pin, and shows it again with the Resolved filter", async () => {
    const { client, wrapper } = await layer([thread(1)]);
    await wrapper.get("[data-slot=comment-pin]").trigger("click");

    await wrapper.get("[aria-label=Resolve]").trigger("click");
    await vi.waitFor(() => expect(client.threads[0]!.status).toBe("resolved"));
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-pin]").exists()).toBe(false);

    await wrapper.get("[data-slot=comment-toolbar-list]").trigger("click");
    const resolved = wrapper.findAll("[data-slot=comment-filter]").find((button) => button.text().startsWith("Resolved"))!;
    await resolved.trigger("click");
    const pin = wrapper.get("[data-slot=comment-pin]");
    expect(pin.attributes("data-status")).toBe("resolved");

    await pin.trigger("click");
    await wrapper.get("[aria-label=Reopen]").trigger("click");
    await vi.waitFor(() => expect(client.threads[0]!.status).toBe("open"));
  });

  it("closes an open thread on a click outside, and shakes its reply when it has text", async () => {
    const { wrapper } = await layer([thread(1)]);
    await wrapper.get("[data-slot=comment-pin]").trigger("click");
    const field = wrapper.get("[data-slot=comment-thread] textarea");
    await field.setValue("Not yet");

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-thread] [data-slot=comment-composer]").attributes("data-shake")).toBe("shake");
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(true);

    await field.setValue("");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(false);
  });

  it("closes an open thread on Esc and leaves comment mode", async () => {
    const { wrapper } = await layer([thread(1)]);
    press("c");
    await wrapper.get("[data-slot=comment-pin]").trigger("click");

    press("Escape");
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(false);
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();
  });

  it("shows live changes that the transport pushes", async () => {
    const { client, transport, wrapper } = await layer();
    await transport.as(ben).create({ anchor: { kind: "element", selector: "#cta", x: 0, y: 0 }, body: "From Ben", subject: pricing });
    await flushPromises();
    expect(client.threads).toHaveLength(1);
    expect(wrapper.findAll("[data-slot=comment-pin]")).toHaveLength(1);
  });
});

describe("deep link", () => {
  function harness(threads: CommentThreadModel[], search: string) {
    const { client } = setup(threads);
    const wrapper = mount(
      defineComponent({
        setup() {
          const comments = useComments({
            client,
            location: () => ({ href: `http://app.test/pricing${search}`, origin: "http://app.test", search }),
            subject: pricing,
          });
          return () => h(CommentLayer, { comments });
        },
      }),
      { attachTo: document.body, global },
    );
    mounted.push(wrapper);
    return { client, wrapper };
  }

  it("opens the thread that ?comment=<n> names", async () => {
    const { client, wrapper } = harness([thread(1), thread(2)], "?comment=2");
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await flushPromises();

    const open = wrapper.get("[data-slot=comment-thread]:not([data-preview])");
    expect(open.attributes("aria-label")).toBe("Comment 2");
    expect(wrapper.get("[data-slot=comment-pin][aria-label='Comment 2']").attributes("data-active")).toBe("true");
  });

  it("opens a resolved thread too, and ignores a number that does not exist", async () => {
    const resolved = harness([thread(1, { status: "resolved" })], "?comment=1");
    await vi.waitFor(() => expect(resolved.client.status).toBe("ready"));
    await flushPromises();
    expect(resolved.wrapper.find("[data-slot=comment-thread]:not([data-preview])").exists()).toBe(true);

    const missing = harness([thread(1)], "?comment=9");
    await vi.waitFor(() => expect(missing.client.status).toBe("ready"));
    await flushPromises();
    expect(missing.wrapper.findAll("[data-slot=comment-thread]:not([data-preview])")).toHaveLength(0);
  });
});

describe("list and filters", () => {
  const threads = [
    thread(1),
    thread(2, { author: ben, messages: [{ ...thread(2).messages[0]!, author: ben }] }),
    thread(3, { status: "resolved" }),
    thread(4, { anchor: { kind: "element", selector: "#gone", x: 0, y: 0 } }),
    thread(5, { subject: about }),
  ];

  async function panel(navigate = vi.fn()) {
    const { client } = setup(threads);
    const wrapper = mount(
      defineComponent({
        setup() {
          const comments = useComments({
            client,
            location: () => ({ href: "http://app.test/pricing", origin: "http://app.test", search: "" }),
            subject: pricing,
          });
          return () => h("div", [h(CommentToolbar, { comments }), h(CommentFilters, { comments }), h(CommentList, { comments, navigate })]);
        },
      }),
      { attachTo: document.body, global },
    );
    mounted.push(wrapper);
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await flushPromises();
    return { navigate, wrapper };
  }

  const numbers = (wrapper: VueWrapper) => wrapper.findAll("[data-slot=comment-list-number]").map((item) => item.text());
  const filter = (wrapper: VueWrapper, label: string) =>
    wrapper.get("[data-slot=comment-list]").findAll("[data-slot=comment-filter]").find((button) => button.text().startsWith(label))!;

  it("lists the open threads of this page, with their counts", async () => {
    const { wrapper } = await panel();
    // Thread 4 is detached, so the list says so.
    expect(numbers(wrapper)).toEqual(["1", "2", "4"]);
    expect(wrapper.get("[data-slot=comment-list-detached]").text()).toBe("Detached");
    expect(filter(wrapper, "Open").text()).toBe("Open 3");
    expect(filter(wrapper, "Resolved").text()).toBe("Resolved 1");
  });

  it("filters by resolved and mine", async () => {
    const { wrapper } = await panel();

    await filter(wrapper, "Resolved").trigger("click");
    expect(numbers(wrapper)).toEqual(["1", "2", "3", "4"]);
    expect(filter(wrapper, "Resolved").attributes("aria-pressed")).toBe("true");

    await filter(wrapper, "Open").trigger("click");
    expect(numbers(wrapper)).toEqual(["3"]);

    await filter(wrapper, "Open").trigger("click");
    await filter(wrapper, "Mine").trigger("click");
    expect(numbers(wrapper)).toEqual(["1", "3", "4"]);

    // With both Open and Resolved off, nothing is left to show.
    await filter(wrapper, "Open").trigger("click");
    await filter(wrapper, "Resolved").trigger("click");
    expect(wrapper.findAll("[data-slot=comment-list-item]")).toHaveLength(0);
    expect(wrapper.get("[data-slot=comment-list-empty]").text()).toBe("No comments here.");
  });

  it("opens a thread of this page from the list", async () => {
    const { wrapper } = await panel();
    await wrapper.findAll("[data-slot=comment-list-item]")[1]!.trigger("click");
    expect(wrapper.findAll("[data-slot=comment-list-item]")[1]!.attributes("aria-current")).toBe("true");
  });

  it("lists the whole site and goes to the page of a thread", async () => {
    const { navigate, wrapper } = await panel();
    await wrapper.findAll("[data-slot=comment-list-scope]")[1]!.trigger("click");
    await vi.waitFor(() => expect(numbers(wrapper)).toEqual(["1", "2", "4", "5"]));

    const row = wrapper.findAll("[data-slot=comment-list-item]")[3]!;
    expect(row.attributes("href")).toBe("/about?comment=5");
    expect(row.text()).toContain("/about");
    await row.trigger("click");
    expect(navigate).toHaveBeenCalledWith("/about?comment=5");
  });

  it("shows how many threads are on this page in the toolbar", async () => {
    const { wrapper } = await panel();
    expect(wrapper.get("[data-slot=comment-toolbar-list]").attributes("aria-label")).toBe("Comment list, 3 on this page");
  });
});

describe("parts without a layer", () => {
  it("throws a coded error when a part has no comments state", () => {
    expect(() => mount(CommentList, { global })).toThrowError(expect.objectContaining({ code: "UI_R0002" }));
  });
});
