// @vitest-environment happy-dom

import {
  createCommentsClient,
  type CommentThread as CommentThreadModel,
  type CommentUser,
} from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import {
  CommentFilters,
  CommentLayer,
  CommentList,
  CommentReply,
  CommentThread,
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

type Page = Pick<VueWrapper, "find" | "findAll" | "get">;

async function drop(wrapper: Page) {
  press("c");
  await flushPromises();
  const overlay = wrapper.get("[data-slot=comment-layer-overlay]");
  await overlay.trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
  await overlay.trigger("pointerup", { button: 0, clientX: 150, clientY: 120 });
  await flushPromises();
}

const composer = (wrapper: Page) => wrapper.get("[data-slot=comment-composer]");
const textarea = (wrapper: Page) => wrapper.get("textarea");

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

  it("ignores C in custom editors, with a modifier, while composing, on repeat, and when something else handled it", async () => {
    const { wrapper } = await layer();
    const active = () => wrapper.get("[data-slot=comment-layer]").attributes("data-active");
    for (const role of ["textbox", "combobox", "searchbox"]) {
      const editor = document.createElement("div");
      editor.setAttribute("role", role);
      document.body.append(editor);
      press("c", {}, editor);
      await flushPromises();
      expect(active(), role).toBeUndefined();
    }
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { repeat: true }]) {
      press("c", init);
      await flushPromises();
      expect(active(), JSON.stringify(init)).toBeUndefined();
    }
    const handled = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "c" });
    document.addEventListener("keydown", (event) => event.preventDefault(), { capture: true, once: true });
    document.dispatchEvent(handled);
    await flushPromises();
    expect(active()).toBeUndefined();
    press("c");
    await flushPromises();
    expect(active()).toBe("true");
  });

  it("drops a numbered pin with the avatar and focuses the composer", async () => {
    const { wrapper } = await layer([thread(4)]);
    await drop(wrapper);

    const pin = wrapper.get("[data-slot=comment-pin][data-draft=true]");
    // The server assigns the number, so the draft pin has none yet.
    expect(pin.find("[data-slot=comment-pin-number]").exists()).toBe(false);
    expect(pin.attributes("aria-label")).toBe("New comment");
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
    expect(wrapper.find("[data-slot=comment-pin][aria-label^='Comment 1 by Ana Ruiz: Make this bigger']").exists()).toBe(true);
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
    expect(pins.map((pin) => pin.attributes("aria-label"))).toEqual(["Comment 1 by Ana Ruiz: Comment 1"]);
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
    expect(wrapper.get("[data-slot=comment-pin][aria-label^='Comment 2']").attributes("data-active")).toBe("true");
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

describe("shadow DOM and keys", () => {
  it("does not toggle comment mode for a key typed in an input inside a shadow root", async () => {
    const { wrapper } = await layer();
    const host = document.createElement("div");
    document.body.append(host);
    const input = host.attachShadow({ mode: "open" }).appendChild(document.createElement("input"));

    // The document sees the host as the target. The input is only in the composed path.
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "c" }));
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();

    press("c");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("looks for composers with text in the shadow root that holds the layer", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const mount_ = document.createElement("div");
    shadow.append(mount_);
    const { client } = setup();
    const wrapper = mount(CommentLayer, { attachTo: mount_, global, props: { client, subject: pricing } });
    mounted.push(wrapper);
    await vi.waitFor(() => expect(client.status).toBe("ready"));

    press("c");
    await flushPromises();
    await wrapper.get("[data-slot=comment-layer-overlay]").trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
    await wrapper.get("[data-slot=comment-layer-overlay]").trigger("pointerup", { button: 0, clientX: 150, clientY: 120 });
    await flushPromises();
    await textarea(wrapper).setValue("Typed in a shadow root");

    // Esc comes from outside the composer. The document cannot see the composer, but the layer's own root can.
    press("Escape", {}, document.body);
    await flushPromises();
    expect(composer(wrapper).attributes("data-shake")).toBe("shake");
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
  });

  it("ignores a key that repeats", async () => {
    const { wrapper } = await layer();
    press("c", { repeat: true });
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();
  });

  it("matches the hotkey without regard to case on both sides", async () => {
    const { wrapper } = await layer([], { hotkey: "C" });
    press("c");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBe("true");
    press("C");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-layer]").attributes("data-active")).toBeUndefined();
  });
});

describe("placing a pin", () => {
  it("drops the pin on pointer up, and not when the pointer moved like a scroll", async () => {
    const { wrapper } = await layer();
    press("c");
    await flushPromises();
    const overlay = wrapper.get("[data-slot=comment-layer-overlay]");

    await overlay.trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
    await overlay.trigger("pointerup", { button: 0, clientX: 150, clientY: 190 });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);

    await overlay.trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
    await overlay.trigger("pointercancel");
    await overlay.trigger("pointerup", { button: 0, clientX: 150, clientY: 120 });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);

    await overlay.trigger("pointerdown", { button: 0, clientX: 150, clientY: 120 });
    await overlay.trigger("pointerup", { button: 0, clientX: 152, clientY: 121 });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(true);
  });

  it("starts a comment on the focused element with Enter in comment mode", async () => {
    const { client, wrapper } = await layer();
    target.focus();
    press("Enter", {}, target);
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);

    press("c");
    await flushPromises();
    press("Enter", {}, target);
    await flushPromises();
    await textarea(wrapper).setValue("Keyboard comment");
    await textarea(wrapper).trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads).toHaveLength(1));
    expect(client.threads[0]!.anchor).toEqual({ kind: "element", selector: "#cta", x: 500, y: 500 });
  });

  it("comments on the whole page from the toolbar", async () => {
    const { client, wrapper } = await layer();
    await wrapper.get("[data-slot=comment-toolbar-page]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-pin-number]").exists()).toBe(false);
    await textarea(wrapper).setValue("About the whole page");
    await textarea(wrapper).trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(client.threads).toHaveLength(1));
    expect(client.threads[0]!.anchor).toEqual({ kind: "page" });
    // A page thread has no spot, so it has no pin. The list has it.
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-pin]").exists()).toBe(false);
  });
});

describe("draft state", () => {
  it("keeps a draft when the parent re-renders with an equal subject object", async () => {
    const { client } = setup();
    const tick = ref(0);
    const wrapper = mount(
      defineComponent({
        setup: () => () => {
          void tick.value;
          // A new object on every render, with the same page in it.
          return h(CommentLayer, { client, subject: { id: "/pricing", kind: "page" } });
        },
      }),
      { attachTo: document.body, global },
    );
    mounted.push(wrapper);
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await drop(wrapper);
    await textarea(wrapper).setValue("Do not lose me");

    tick.value++;
    await flushPromises();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Do not lose me");
  });

  it("drops the draft when the page really changes", async () => {
    const { client } = setup();
    const page = ref("/pricing");
    const wrapper = mount(
      defineComponent({ setup: () => () => h(CommentLayer, { client, subject: { id: page.value, kind: "page" } }) }),
      { attachTo: document.body, global },
    );
    mounted.push(wrapper);
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await drop(wrapper);
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(true);

    page.value = "/about";
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
  });
});

describe("thread actions", () => {
  const message = thread(1).messages[0]!;

  function pending() {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return { fail, finish, promise };
  }

  it("keeps the reply and shows the error when sending fails, and clears it after success", async () => {
    const onReply = vi.fn().mockRejectedValueOnce(new Error("Offline.")).mockResolvedValueOnce(undefined);
    const wrapper = mount(CommentThread, { attachTo: document.body, global, props: { onReply, thread: thread(1), user: ana } });
    mounted.push(wrapper);
    const field = wrapper.get("textarea");

    await field.setValue("Please answer");
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect((field.element as HTMLTextAreaElement).value).toBe("Please answer");
    expect(wrapper.get("[data-slot=comment-composer-error]").text()).toBe("Offline.");

    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(onReply).toHaveBeenCalledTimes(2);
    expect((field.element as HTMLTextAreaElement).value).toBe("");
    expect(wrapper.find("[data-slot=comment-composer-error]").exists()).toBe(false);
  });

  it("does not send twice while the first send is on its way", async () => {
    const first = pending();
    const onReply = vi.fn().mockReturnValue(first.promise);
    const wrapper = mount(CommentThread, { attachTo: document.body, global, props: { onReply, thread: thread(1), user: ana } });
    mounted.push(wrapper);
    const field = wrapper.get("textarea");

    await field.setValue("Once");
    await field.trigger("keydown", { key: "Enter" });
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(wrapper.get("[data-slot=comment-composer]").attributes("data-busy")).toBe("true");

    first.finish();
    await flushPromises();
    expect((field.element as HTMLTextAreaElement).value).toBe("");
  });

  it("closes the edit box only after the edit was saved", async () => {
    const save = pending();
    const onEdit = vi.fn().mockReturnValueOnce(save.promise);
    const wrapper = mount(CommentReply, { attachTo: document.body, global, props: { editable: true, message, onEdit } });
    mounted.push(wrapper);
    await wrapper.get("[aria-label=Edit]").trigger("click");
    const editor = wrapper.get("textarea");
    await editor.setValue("Changed");
    await editor.trigger("keydown", { key: "Enter" });
    await editor.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(wrapper.find("textarea").exists()).toBe(true);

    save.fail(new Error("Not saved."));
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(true);
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Changed");
    expect(wrapper.get("[data-slot=comment-composer-error]").text()).toBe("Not saved.");

    onEdit.mockResolvedValueOnce(undefined);
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(wrapper.find("textarea").exists()).toBe(false);
  });

  it("asks before it deletes the first message, which deletes the thread", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(CommentThread, { attachTo: document.body, global, props: { onDelete, thread: thread(1), user: ana } });
    mounted.push(wrapper);

    await wrapper.get("[aria-label=Delete]").trigger("click");
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = wrapper.get("[data-slot=comment-reply-confirm]");
    await confirm.findAll("button").find((button) => button.text() === "Cancel")!.trigger("click");
    expect(wrapper.find("[data-slot=comment-reply-confirm]").exists()).toBe(false);

    await wrapper.get("[aria-label=Delete]").trigger("click");
    await wrapper.get("[data-slot=comment-reply-confirm]").findAll("button").find((button) => button.text() === "Delete thread")!.trigger("click");
    await flushPromises();
    expect(onDelete).toHaveBeenCalledWith("message-1");
  });

  it("shows a failed Resolve", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("Not allowed."));
    const wrapper = mount(CommentThread, { attachTo: document.body, global, props: { onResolve, thread: thread(1), user: ana } });
    mounted.push(wrapper);
    await wrapper.get("[aria-label=Resolve]").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-composer-error]").text()).toBe("Not allowed.");
  });

  it("drops the mention of a person whose @name is gone from an edited message", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const withMention = { ...message, author: ana, body: "Hi @Ben Soto and @Ana Ruiz", mentions: ["ben", "ana"] };
    const wrapper = mount(CommentReply, {
      attachTo: document.body,
      global,
      props: { editable: true, message: withMention, onEdit, people: [ana, ben] },
    });
    mounted.push(wrapper);
    await wrapper.get("[aria-label=Edit]").trigger("click");
    const editor = wrapper.get("textarea");

    await editor.setValue("Hi @Ana Ruiz only");
    await editor.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(onEdit).toHaveBeenCalledWith("message-1", "Hi @Ana Ruiz only", ["ana"]);
  });

  it("drops a mention of a person whose name is not known", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(CommentReply, {
      attachTo: document.body,
      global,
      props: { editable: true, message: { ...message, body: "Hi @Cleo", mentions: ["cleo"] }, onEdit },
    });
    mounted.push(wrapper);
    await wrapper.get("[aria-label=Edit]").trigger("click");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(onEdit).toHaveBeenCalledWith("message-1", "Hi @Cleo", []);
  });
});

describe("accessibility", () => {
  it("moves the focus into an opened thread and back to its pin when it closes", async () => {
    const { wrapper } = await layer([thread(1)]);
    const pin = wrapper.get("[data-slot=comment-pin]");
    await pin.trigger("click");
    await flushPromises();
    const dialog = wrapper.get("[data-slot=comment-thread]:not([data-preview])");
    expect(document.activeElement).toBe(dialog.element);

    press("Escape");
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-thread]:not([data-preview])").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get("[data-slot=comment-pin]").element);
  });

  it("does not take the focus back when the reader went elsewhere", async () => {
    const { wrapper } = await layer([thread(1)]);
    await wrapper.get("[data-slot=comment-pin]").trigger("click");
    await flushPromises();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();

    await wrapper.get("[aria-label=Close]").trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(other);
  });

  it("wires the mention list to the box with combobox attributes", async () => {
    const { wrapper } = await layer();
    await drop(wrapper);
    const field = textarea(wrapper);
    expect(field.attributes("aria-expanded")).toBeUndefined();

    await field.setValue("@b");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(true));
    await flushPromises();
    const list = wrapper.get("[data-slot=comment-composer-mentions]");
    const option = wrapper.get("[data-slot=comment-composer-mention]");
    expect(field.attributes()).toMatchObject({
      "aria-activedescendant": option.attributes("id"),
      "aria-autocomplete": "list",
      "aria-controls": list.attributes("id"),
      "aria-expanded": "true",
      role: "combobox",
    });

    await field.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(field.attributes("aria-expanded")).toBe("false");
    expect(field.attributes("aria-controls")).toBeUndefined();
  });

  it("names a pin by its number, its author, and the start of the comment", async () => {
    const long = "word ".repeat(40);
    const { wrapper } = await layer([thread(3, { author: ben, messages: [{ ...thread(3).messages[0]!, author: ben, body: long }], status: "resolved" })], {});
    await wrapper.get("[data-slot=comment-toolbar-list]").trigger("click");
    await wrapper.findAll("[data-slot=comment-filter]").find((button) => button.text().startsWith("Resolved"))!.trigger("click");
    const label = wrapper.get("[data-slot=comment-pin]").attributes("aria-label")!;
    expect(label.startsWith("Comment 3 by Ben Soto: word word")).toBe(true);
    expect(label.endsWith("…, resolved")).toBe(true);
    expect(label.length).toBeLessThan(100);
  });
});

describe("links and layout", () => {
  it("builds links from subjectUrl for subjects that are not pages", async () => {
    const doc = { id: "docs/intro", kind: "content" };
    const { client } = setup([thread(1, { subject: doc }), thread(2)]);
    const wrapper = mount(
      defineComponent({
        setup() {
          const comments = useComments({
            client,
            location: () => ({ href: "http://app.test/pricing", origin: "http://app.test", search: "" }),
            subject: pricing,
            subjectUrl: (subject) => (subject.kind === "content" ? `/docs/${subject.id.split("/")[1]}` : undefined),
          });
          comments.scope.value = "site";
          return () => h(CommentList, { comments });
        },
      }),
      { attachTo: document.body, global },
    );
    mounted.push(wrapper);
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await flushPromises();
    expect(wrapper.findAll("[data-slot=comment-list-item]").map((row) => row.attributes("href"))).toEqual(["/docs/intro?comment=1", "/pricing?comment=2"]);
  });

  it("opens the thread again when history navigation changes the comment parameter", async () => {
    let search = "";
    const { client } = setup([thread(1), thread(2)]);
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
    await vi.waitFor(() => expect(client.status).toBe("ready"));
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-thread]:not([data-preview])").exists()).toBe(false);

    search = "?comment=2";
    window.dispatchEvent(new Event("popstate"));
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-thread]:not([data-preview])").attributes("aria-label")).toBe("Comment 2");
  });

  it("follows its element when a class or style change moves it", async () => {
    const { wrapper } = await layer([thread(1)]);
    expect(wrapper.get("[data-slot=comment-layer-item]").attributes("style")).toContain("left: 200px");

    rect.left = 300;
    target.setAttribute("class", "moved");
    await vi.waitFor(() => expect(wrapper.get("[data-slot=comment-layer-item]").attributes("style")).toContain("left: 400px"));
    rect.left = 100;
  });

  it("hides the pin of an element that a scroll container clips", async () => {
    document.body.innerHTML = `<main><div id="list" style="overflow: auto"><button id="cta">Buy</button></div></main>`;
    target = document.getElementById("cta")!;
    const list = document.getElementById("list")!;
    const rects = new Map<Element, typeof rect>([[list, { height: 100, left: 0, top: 0, width: 400 }], [target, rect]]);
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      const box = rects.get(this) ?? { height: 0, left: 0, top: 0, width: 0 };
      return { ...box, bottom: box.top + box.height, right: box.left + box.width, toJSON: () => box, x: box.left, y: box.top };
    });
    rects.set(target, { height: 40, left: 100, top: 60, width: 200 });
    const { wrapper } = await layer([thread(1)]);
    expect(wrapper.find("[data-slot=comment-pin]").exists()).toBe(true);

    // The list scrolled, so the button is below its bottom edge.
    rects.set(target, { height: 40, left: 100, top: 400, width: 200 });
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-pin]").exists()).toBe(false));
  });
});
