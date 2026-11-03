// @vitest-environment happy-dom

import {
  createCommentsClient,
  type CommentMessage,
  type CommentThread as CommentThreadModel,
  type CommentUser,
} from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import {
  CommentComposer,
  CommentPanel,
  CommentReply,
  CommentThread,
  provideComments,
  useComments,
} from "../src/index.ts";
import { mentionQuery, rankPeople } from "../src/internal/comment-mentions.ts";

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const ben: CommentUser = { id: "ben", name: "Ben Soto" };
const jose: CommentUser = { id: "jose", name: "José Ávila" };
const sofia: CommentUser = { id: "sofia", name: "Sofía Benítez" };
const pricing = { id: "/pricing", kind: "page" };

const UButton = defineComponent({
  setup(_props, { attrs }) {
    return () => h("button", { ...attrs, type: "button" }, typeof attrs.label === "string" ? attrs.label : undefined);
  },
});
const UModal = defineComponent({ setup: (_props, { slots }) => () => slots.default?.() });
const global = { components: { UButton, UIcon: defineComponent({ setup: () => () => h("span") }), UModal } };

const mounted: VueWrapper[] = [];

beforeEach(() => {
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++next}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function message(id: string, patch: Partial<CommentMessage> = {}): CommentMessage {
  return { attachments: [], author: ana, body: "Comment", createdAt: 1_000, id, mentions: [], threadId: "thread-1", ...patch };
}

function thread(n: number, patch: Partial<CommentThreadModel> = {}): CommentThreadModel {
  const id = `thread-${n}`;
  return {
    anchor: { kind: "page" },
    author: ana,
    createdAt: 1_000,
    id,
    messages: [message(`message-${n}`, { body: `Comment ${n}`, threadId: id })],
    n,
    scope: "site",
    status: "open",
    subject: pricing,
    updatedAt: 1_000,
    ...patch,
  };
}

function client(threads: CommentThreadModel[] = []) {
  return createCommentsClient({ transport: createMemoryTransport({ threads, user: ana, users: [ana, ben, jose, sofia] }), user: ana });
}

function keep<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

// Puts a part inside a comments state, as CommentLayer does, without the layer.
function withState(child: () => ReturnType<typeof h>, comments = client()) {
  return defineComponent({
    setup() {
      provideComments(useComments({ client: comments, subject: pricing }));
      return child;
    },
  });
}

function addFiles(wrapper: Pick<VueWrapper, "get">, files: File[]) {
  const input = wrapper.get("input[type=file]").element as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
}

describe("mention ranking", () => {
  const people = [sofia, ben, jose, ana];

  it("puts names that start with the query first, then names with a later word that does", () => {
    expect(rankPeople(people, "be").map(person => person.id)).toEqual(["ben", "sofia"]);
  });

  it("ignores accents and case", () => {
    expect(rankPeople(people, "JOSE").map(person => person.id)).toEqual(["jose"]);
    expect(rankPeople(people, "avi").map(person => person.id)).toEqual(["jose"]);
  });

  it("puts people of the conversation first in each group and leaves out the signed-in user", () => {
    expect(rankPeople(people, "", { participants: ["jose"], exclude: "ana" }).map(person => person.id)).toEqual(["jose", "sofia", "ben"]);
  });

  it("leaves out a finished mention, so the menu does not open again after a pick", () => {
    expect(rankPeople(people, "Ben Soto ")).toEqual([]);
  });

  it("reads a query with spaces, because names have them", () => {
    expect(mentionQuery("Hi @Ben S", 9)).toEqual({ query: "Ben S", start: 3 });
    expect(mentionQuery("mail@ben", 8)).toBeUndefined();
    expect(mentionQuery("Hi @Ben\nnext", 12)).toBeUndefined();
  });
});

describe("composer mentions", () => {
  it("finds people through the comments state when no users or people are given", async () => {
    const text = ref("");
    const wrapper = keep(mount(withState(() => h(CommentComposer, {
      autofocus: false,
      guard: false,
      modelValue: text.value,
      "onUpdate:modelValue": (value: string) => (text.value = value),
    })), { attachTo: document.body, global }));
    const field = wrapper.get("textarea");
    await field.setValue("Hi @be");
    await vi.waitFor(() => expect(wrapper.findAll("[data-slot=comment-composer-mention-name]").map(item => item.text())).toEqual(["Ben Soto", "Sofía Benítez"]));
    const listbox = wrapper.get("[role=listbox]");
    expect(field.attributes("aria-controls")).toBe(listbox.attributes("id"));
    expect(field.attributes("aria-activedescendant")).toBe(wrapper.findAll("[role=option]")[0]!.attributes("id"));

    await field.trigger("keydown", { key: "ArrowDown" });
    expect(field.attributes("aria-activedescendant")).toBe(wrapper.findAll("[role=option]")[1]!.attributes("id"));
    await field.trigger("keydown", { key: "Tab" });
    await flushPromises();
    expect(field.element).toHaveProperty("value", "Hi @Sofía Benítez ");
    expect(wrapper.findComponent(CommentComposer).emitted("update:mentions")?.at(-1)).toEqual([["sofia"]]);
  });

  it("never suggests the signed-in user", async () => {
    const wrapper = keep(mount(withState(() => h(CommentComposer, { autofocus: false, guard: false })), { attachTo: document.body, global }));
    await wrapper.get("textarea").setValue("@an");
    await flushPromises();
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(false);
  });

  it("lets a users prop win over the comments state", async () => {
    const users = vi.fn(async () => [jose]);
    const wrapper = keep(mount(withState(() => h(CommentComposer, { autofocus: false, guard: false, users })), { attachTo: document.body, global }));
    await wrapper.get("textarea").setValue("@j");
    await vi.waitFor(() => expect(wrapper.findAll("[data-slot=comment-composer-mention-name]").map(item => item.text())).toEqual(["José Ávila"]));
    expect(users).toHaveBeenCalledWith("j");
  });

  it("closes only the menu on Esc, keeps the text, and leaves it closed for that mention", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false, people: [ben] } }));
    const field = wrapper.get("textarea");
    await field.setValue("@b");
    await vi.waitFor(() => expect(wrapper.find("[role=listbox]").exists()).toBe(true));
    await field.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    expect(wrapper.emitted("cancel")).toBeUndefined();
    await field.setValue("@be");
    await flushPromises();
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    expect(field.element).toHaveProperty("value", "@be");
  });

  it("renders a mention-item slot with the person and whether it is active", async () => {
    const wrapper = keep(mount(CommentComposer, {
      attachTo: document.body,
      global,
      props: { autofocus: false, guard: false, people: [ben, sofia] },
      slots: { "mention-item": ({ person, active }: { person: CommentUser; active: boolean }) => h("b", `${person.name}${active ? " *" : ""}`) },
    }));
    await wrapper.get("textarea").setValue("@be");
    await vi.waitFor(() => expect(wrapper.findAll("[role=option] b").map(item => item.text())).toEqual(["Ben Soto *", "Sofía Benítez"]));
  });

  it("renders the extra slot above the text field", () => {
    const wrapper = keep(mount(CommentComposer, { global, props: { autofocus: false, guard: false }, slots: { extra: () => h("input", { name: "suggestion" }) } }));
    const box = wrapper.get("[data-slot=comment-composer-box]").element;
    expect(box.firstElementChild?.getAttribute("data-slot")).toBe("comment-composer-extra");
    expect(wrapper.find("[data-slot=comment-composer-extra] input[name=suggestion]").exists()).toBe(true);
  });
});

describe("composer attachments", () => {
  const shot = new File(["png"], "shot.png", { type: "image/png" });
  const notes = new File(["text"], "notes.txt", { type: "text/plain" });

  it("sends the picked files with the text", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false, modelValue: "See this" } }));
    addFiles(wrapper, [shot]);
    await flushPromises();
    expect(wrapper.emitted("update:files")?.at(-1)).toEqual([[shot]]);
    expect(wrapper.get("[data-slot=comment-composer]").attributes("data-dirty")).toBe("true");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.at(-1)).toEqual([{ body: "See this", files: [shot], mentions: [] }]);
  });

  it("takes only the files that match accept", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { accept: "image/*", autofocus: false, guard: false } }));
    addFiles(wrapper, [shot, notes]);
    await flushPromises();
    expect(wrapper.emitted("update:files")?.at(-1)).toEqual([[shot]]);
  });

  it("drops files on the box", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false } }));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [shot], types: ["Files"] } });
    wrapper.get("[data-slot=comment-composer]").element.dispatchEvent(drop);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(wrapper.emitted("update:files")?.at(-1)).toEqual([[shot]]);
  });

  it("does not send files without text in a new comment unless allowEmpty is on", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false } }));
    addFiles(wrapper, [shot]);
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.get("[role=alert]").text()).toBe("Write a comment to send with the files.");

    await wrapper.setProps({ allowEmpty: true });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.at(-1)).toEqual([{ body: "", files: [shot], mentions: [] }]);
  });

  it("sends files without text in a reply", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false, variant: "reply" } }));
    addFiles(wrapper, [shot]);
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.at(-1)).toEqual([{ body: "", files: [shot], mentions: [] }]);
  });

  it("has no file button when attachments is off, or while editing", () => {
    expect(keep(mount(CommentComposer, { global, props: { attachments: false, autofocus: false } })).find("input[type=file]").exists()).toBe(false);
    expect(keep(mount(CommentComposer, { global, props: { autofocus: false, variant: "edit" } })).find("input[type=file]").exists()).toBe(false);
  });
});

describe("posted messages", () => {
  it("shows each mentioned person as a chip, marks the signed-in user, and keeps other Markdown", async () => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: {
        message: message("m1", { body: "**Look** @Ben Soto and @Ana Ruiz, not `@Ben Soto` or @Ana", mentions: ["ben", "ana"] }),
        people: [ana, ben],
        user: ana,
      },
    }));
    await vi.waitFor(() => expect(wrapper.findAll("[data-slot=comment-mention]")).toHaveLength(2));
    const chips = wrapper.findAll("[data-slot=comment-mention]");
    expect(chips.map(chip => chip.text())).toEqual(["@Ben Soto", "@Ana Ruiz"]);
    expect(chips.map(chip => chip.attributes("data-self"))).toEqual([undefined, "true"]);
    expect(wrapper.get("strong").text()).toBe("Look");
    expect(wrapper.get("code").text()).toBe("@Ben Soto");
  });

  it("does not mark a name that the message does not mention", async () => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: { message: message("m1", { body: "Hi @Ben Soto :comment-mention{user=\"ana\" label=\"Ana Ruiz\"}", mentions: [] }), people: [ana, ben] },
    }));
    await vi.waitFor(() => expect(wrapper.text()).toContain("Hi @Ben Soto"));
    expect(wrapper.find("[data-slot=comment-mention]").exists()).toBe(false);
  });

  it("names a mention from the comments state when no people are given", async () => {
    const wrapper = keep(mount(withState(() => h(CommentReply, { message: message("m1", { author: ben, body: "Ping @Ana Ruiz", mentions: ["ana"] }) })), { global }));
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-mention]").exists()).toBe(true));
    expect(wrapper.get("[data-slot=comment-mention]").attributes("data-self")).toBe("true");
  });

  it("shows image attachments as thumbnails and other files as links", async () => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: {
        attachmentUrl: (key: string) => `https://files.test/${key}`,
        message: message("m1", { attachments: ["shots/a.png", "docs/spec.pdf"] }),
      },
    }));
    const group = wrapper.get("[data-slot=comment-reply-attachments]");
    expect(group.get("img").attributes("src")).toBe("https://files.test/shots/a.png");
    expect(group.get("a").attributes("href")).toBe("https://files.test/docs/spec.pdf");
    expect(group.get("a").text()).toBe("spec.pdf");
  });

  it("replaces the body and the attachments through slots", () => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: { message: message("m1", { attachments: ["a.png"], body: "Hidden" }) },
      slots: {
        attachments: ({ message: item }: { message: CommentMessage }) => h("i", item.attachments.join(",")),
        body: ({ message: item }: { message: CommentMessage }) => h("p", { class: "own" }, item.id),
      },
    }));
    expect(wrapper.get(".own").text()).toBe("m1");
    expect(wrapper.get("i").text()).toBe("a.png");
    expect(wrapper.find("[data-slot=comment-reply-body]").exists()).toBe(false);
  });
});

describe("thread slots", () => {
  it("renders actions, anchor, and after with the thread, and forwards the reply and composer slots", () => {
    const quoted = thread(4, { anchor: { exact: "Pricing", kind: "text", prefix: "", selector: "h1", suffix: "" } });
    const scope = (name: string) => ({ thread: item }: { thread: CommentThreadModel }) => h("span", { class: name }, String(item.n));
    const wrapper = keep(mount(CommentThread, {
      global,
      props: { thread: quoted, user: ana },
      slots: {
        actions: scope("action"),
        after: scope("after"),
        anchor: scope("anchor"),
        body: ({ message: item }: { message: CommentMessage }) => h("p", { class: "body" }, item.body),
        extra: () => h("span", { class: "extra" }),
      },
    }));
    expect(wrapper.get("[data-slot=comment-thread-actions] .action").text()).toBe("4");
    expect(wrapper.get(".anchor").text()).toBe("4");
    expect(wrapper.find("[data-slot=comment-thread-quote]").exists()).toBe(false);
    expect(wrapper.get("[data-slot=comment-thread-after] .after").text()).toBe("4");
    expect(wrapper.get(".body").text()).toBe("Comment 4");
    expect(wrapper.find("[data-slot=comment-composer] .extra").exists()).toBe(true);
    // The header order: the slot sits before Resolve.
    const header = wrapper.get("[data-slot=comment-thread-header]").element;
    const actions = header.querySelector("[data-slot=comment-thread-actions]")!;
    expect(actions.nextElementSibling?.getAttribute("aria-label")).toBe("Resolve");
  });

  it("sends the reply files to onReply", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    const wrapper = keep(mount(CommentThread, { attachTo: document.body, global, props: { onReply, thread: thread(1), user: ana } }));
    addFiles(wrapper, [shot]);
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onReply).toHaveBeenCalledWith("", [], [shot]);
    expect(wrapper.find("[data-slot=prompt-input-attachments]").exists()).toBe(false);
  });
});

describe("CommentPanel", () => {
  async function panel(threads: CommentThreadModel[], props: Record<string, unknown> = {}) {
    const comments = client(threads);
    const wrapper = keep(mount(CommentPanel, { attachTo: document.body, global, props: { client: comments, subject: pricing, ...props } }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    return { comments, wrapper };
  }

  it("lists open threads, switches to resolved ones, opens a thread, and goes back", async () => {
    const { wrapper } = await panel([thread(1), thread(2, { status: "resolved" })]);
    const rows = () => wrapper.findAll("[data-slot=comment-panel-item]");
    expect(rows().map(row => row.attributes("data-thread-id"))).toEqual(["thread-1"]);
    expect(wrapper.findAll("[data-slot=comment-panel-filter]").map(button => button.text())).toEqual(["Open 1", "Resolved 1"]);

    await wrapper.findAll("[data-slot=comment-panel-filter]")[1]!.trigger("click");
    expect(rows().map(row => row.attributes("data-thread-id"))).toEqual(["thread-2"]);
    expect(wrapper.emitted("update:status")).toEqual([["resolved"]]);

    await rows()[0]!.trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-panel]").attributes("data-view")).toBe("thread");
    expect(wrapper.emitted("update:thread")?.at(-1)).toEqual(["thread-2"]);
    expect(wrapper.find("[aria-label=Close]").exists()).toBe(false);

    await wrapper.get("[aria-label='Back to comments']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-slot=comment-panel]").attributes("data-view")).toBe("list");
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe("thread-2");
  });

  it("stays open on a click outside, as a side panel does", async () => {
    const { wrapper } = await panel([thread(1)], { thread: "thread-1" });
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(wrapper.emitted("update:thread")).toBeUndefined();
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(true);
  });

  it("comments on the whole page from the box at the bottom and clears it", async () => {
    const { comments, wrapper } = await panel([]);
    expect(wrapper.get("[data-slot=comment-panel-empty]").text()).toBe("No open comments.");
    const field = wrapper.get("[data-slot=comment-panel-composer] textarea");
    await field.setValue("The whole page is great");
    await field.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(comments.threads).toHaveLength(1));
    expect(comments.threads[0]).toMatchObject({ anchor: { kind: "page" }, subject: pricing });
    await flushPromises();
    expect(field.element).toHaveProperty("value", "");
    expect(wrapper.findAll("[data-slot=comment-panel-item]")).toHaveLength(1);
  });

  it("uploads files and sends their keys, and takes no files without upload", async () => {
    const plain = await panel([]);
    expect(plain.wrapper.find("input[type=file]").exists()).toBe(false);

    const upload = vi.fn(async (files: File[]) => files.map(file => `uploads/${file.name}`));
    const { comments, wrapper } = await panel([thread(1)], { thread: "thread-1", upload });
    addFiles(wrapper, [new File(["png"], "shot.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("Here is the shot");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await vi.waitFor(() => expect(comments.threads[0]!.messages).toHaveLength(2));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(comments.threads[0]!.messages[1]!.attachments).toEqual(["uploads/shot.png"]);
  });

  it("forwards the thread slots", async () => {
    const comments = client([thread(1)]);
    const wrapper = keep(mount(CommentPanel, {
      global,
      props: { client: comments, subject: pricing, thread: "thread-1" },
      slots: { actions: ({ thread: item }: { thread: CommentThreadModel }) => h("span", { class: "own-action" }, String(item.n)) },
    }));
    await vi.waitFor(() => expect(wrapper.find(".own-action").exists()).toBe(true));
    expect(wrapper.get(".own-action").text()).toBe("1");
  });
});
