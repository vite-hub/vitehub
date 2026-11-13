// @vitest-environment happy-dom

import {
  createCommentsClient,
  type CommentMessage,
  type CommentThread as CommentThreadModel,
  type CommentUser,
} from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { createRpcTransport } from "@vite-hub/comments/rpc";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Component } from "vue";
import {
  CommentComposer,
  CommentLayer,
  CommentPanel,
  CommentReply,
  CommentThread,
  CommentToolbar,
  createViteHubUI,
  provideComments,
  useComments,
  type CommentRowSlotScope,
} from "../src/index.ts";
import { mentionQuery, rankPeople } from "../src/internal/comment-mentions.ts";
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

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

  it("uses the same case folding on Turkish hosts", () => {
    const lower = String.prototype.toLocaleLowerCase;
    vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      return lower.call(this, "tr");
    });
    expect(rankPeople([{ id: "ibrahim", name: "İbrahim" }], "i").map(person => person.id)).toEqual(["ibrahim"]);
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
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mention-empty]").exists()).toBe(true));
    expect(wrapper.find("[role=option]").exists()).toBe(false);
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

  it("warns again on Esc after the files change, and discards only on an Esc right after a warning", async () => {
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, attachments: true, files: [], modelValue: "Half a thought" } }));
    const field = wrapper.get("textarea");
    const status = () => wrapper.get("[data-slot=comment-composer-status]").text();
    await field.trigger("keydown", { key: "Escape" });
    expect(status()).toBe("Press Esc again to discard.");
    await wrapper.setProps({ files: [file] });
    expect(status()).toBe("");
    await field.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeUndefined();
    await field.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("keeps the text while Esc is held down", async () => {
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, modelValue: "Half a thought" } }));
    const field = wrapper.get("textarea");
    await field.trigger("keydown", { key: "Escape" });
    await field.trigger("keydown", { key: "Escape", repeat: true });
    await field.trigger("keydown", { key: "Escape", repeat: true });
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeUndefined();
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    await field.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("forgets the first Esc after two seconds, so a late Esc shakes again", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, modelValue: "Half a thought" } }));
      const field = wrapper.get("textarea");
      await field.trigger("keydown", { key: "Escape" });
      expect(wrapper.get("[data-slot=comment-composer-status]").text()).toBe("Press Esc again to discard.");
      await vi.advanceTimersByTimeAsync(2100);
      expect(wrapper.get("[data-slot=comment-composer-status]").text()).toBe("");
      await field.trigger("keydown", { key: "Escape" });
      await vi.advanceTimersByTimeAsync(0);
      expect(wrapper.emitted("cancel")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it.each([
    { failed: true, line: "Could not load people.", users: async () => { throw new Error("401") } },
    { failed: false, line: "No one by that name can be mentioned here.", users: async () => [ben] },
  ])("shows a line that is not an option when the lookup has no one to show (failed: $failed)", async ({ failed, line, users }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper: VueWrapper = keep(mount(CommentComposer, {
      attachTo: document.body,
      global,
      props: { autofocus: false, guard: false, users, "onUpdate:modelValue": (value: string) => wrapper.setProps({ modelValue: value }) },
    }));
    const field = wrapper.get("textarea");
    await field.setValue("@zo");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mention-empty]").exists()).toBe(true));
    expect(wrapper.get("[data-slot=comment-composer-mentions]").attributes()).toMatchObject({ "data-state": failed ? "error" : "empty", role: "status" });
    expect(wrapper.get("[data-slot=comment-composer-mention-empty]").text()).toBe(line);
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
    expect(wrapper.find("[role=option]").exists()).toBe(false);
    expect(field.attributes("aria-expanded")).toBe("false");
    expect(field.attributes("aria-controls")).toBeUndefined();
    expect(field.attributes("aria-activedescendant")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(failed ? 1 : 0);

    // The arrows and Tab pick nothing, and Enter sends the text as it is.
    await field.trigger("keydown", { key: "ArrowDown" });
    await field.trigger("keydown", { key: "Tab" });
    await field.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(field.element).toHaveProperty("value", "@zo");
    expect(wrapper.emitted("update:mentions")).toBeUndefined();
    expect(wrapper.emitted("submit")).toEqual([[{ body: "@zo", files: [], mentions: [] }]]);

    await field.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(false);
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  it.each(["@z", "@zo b"])("keeps the menu closed when %j finds no one, as the text is too short or after a space", async (value) => {
    const users = vi.fn(async () => []);
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false, users } }));
    await wrapper.get("textarea").setValue(value);
    await vi.waitFor(() => expect(users).toHaveBeenCalled());
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-composer-mentions]").exists()).toBe(false);
  });

  it("renders a mention-empty slot with the query and whether the lookup failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = keep(mount(CommentComposer, {
      attachTo: document.body,
      global,
      props: { autofocus: false, guard: false, users: async () => { throw new Error("offline") } },
      slots: { "mention-empty": ({ query, failed }: { query: string; failed: boolean }) => h("b", `${query} ${failed}`) },
    }));
    await wrapper.get("textarea").setValue("@zoe");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-composer-mention-empty] b").exists()).toBe(true));
    expect(wrapper.get("[data-slot=comment-composer-mention-empty] b").text()).toBe("zoe true");
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

  it("revokes previews when a controlled file list is cleared or mutated", async () => {
    const files = ref([shot, notes]);
    const wrapper = keep(mount(defineComponent({ setup: () => () => h(CommentComposer, { autofocus: false, files: files.value }) }), { global }));
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    files.value.splice(0, 1);
    await flushPromises();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    files.value = [];
    await flushPromises();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    files.value = [shot];
    await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

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

  it("shows image attachments as thumbnails that open full size, and other files as chips with links", async () => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: {
        attachmentUrl: (key: string) => `https://files.test/${key}`,
        message: message("m1", { attachments: ["shots/a.png", "docs/spec.pdf"] }),
      },
    }));
    const images = wrapper.get("[data-slot=comment-reply-images]");
    expect(images.get("button.vh-image-preview").attributes("aria-label")).toBe("Preview a.png");
    expect(images.get("img").attributes("src")).toBe("https://files.test/shots/a.png");
    expect(images.find("[data-slot=attachment]").exists()).toBe(false);
    const chips = wrapper.get("[data-slot=comment-reply-attachments]");
    expect(chips.find("img").exists()).toBe(false);
    expect(chips.get("a").attributes("href")).toBe("https://files.test/docs/spec.pdf");
    expect(chips.get("a").text()).toBe("spec.pdf");
  });

  it("takes the name and media type of an attachment from attachmentUrl", () => {
    const files: Record<string, { name: string; type: string }> = { drop1: { name: "shot.webp", type: "image/webp" }, drop2: { name: "notes", type: "text/plain" } };
    const wrapper = keep(mount(CommentReply, {
      global,
      props: {
        attachmentUrl: (key: string) => ({ url: `/files/${key}`, ...files[key] }),
        message: message("m1", { attachments: ["drop1", "drop2"] }),
      },
    }));
    expect(wrapper.get("[data-slot=comment-reply-images] img").attributes()).toMatchObject({ alt: "shot.webp", src: "/files/drop1" });
    expect(wrapper.get("[data-slot=comment-reply-attachments] a").text()).toBe("notes");
  });

  it("puts the avatar, the name, and the time on one row above the text", () => {
    const wrapper = keep(mount(CommentReply, { global, props: { message: message("m1") } }));
    const header = wrapper.get("[data-slot=comment-reply-header]");
    expect(header.findAll(":scope > [data-slot]").map(part => part.attributes("data-slot"))).toEqual(["avatar-stack", "comment-reply-author", "comment-reply-time"]);
    expect(wrapper.findAll("[data-slot=comment-reply] > [data-slot=avatar-stack]")).toHaveLength(0);
  });

  it("names files without a link when there is no attachmentUrl", () => {
    const wrapper = keep(mount(CommentReply, { global, props: { message: message("m1", { attachments: ["shots/a.png"] }) } }));
    expect(wrapper.find("[data-slot=comment-reply-images]").exists()).toBe(false);
    expect(wrapper.get("[data-slot=comment-reply-attachments]").text()).toBe("a.png");
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
  it.each([false, true])("provides its explicit state to children with ancestor=%s", async (ancestor) => {
    const selected = client([thread(1, { messages: [message("m1", { body: "Hello @Ben Soto", mentions: ["ben"], author: ben })] })]);
    const wrapper = keep(mount(defineComponent({
      setup() {
        if (ancestor) provideComments(useComments({ client: createCommentsClient({ transport: createMemoryTransport({ user: ana, users: [ana, jose] }), user: ana }), subject: pricing }));
        const comments = useComments({ client: selected, subject: pricing });
        return () => h(CommentPanel, { comments });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(selected.status).toBe("ready"));
    await wrapper.get("textarea").setValue("@be");
    await vi.waitFor(() => expect(wrapper.findAll("[data-slot=comment-composer-mention-name]").map(item => item.text())).toEqual(["Ben Soto", "Sofía Benítez"]));
    await wrapper.get("[data-slot=comment-panel-item]").trigger("click");
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-mention]").text()).toBe("@Ben Soto"));
  });

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

  it("only opens threads in the current page scope, including after a subject change", async () => {
    const about = { id: "/about", kind: "page" };
    const { comments, wrapper } = await panel([thread(1), thread(2, { subject: about })], { thread: "thread-1" });
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(true);
    let finish!: (threads: CommentThreadModel[]) => void;
    vi.spyOn(comments.transport, "list").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

    await wrapper.setProps({ subject: about });
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(false);

    finish([thread(2, { subject: about })]);
    await flushPromises();
    expect(wrapper.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-2"]);

    await wrapper.setProps({ thread: "thread-2" });
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

  it("puts list-actions on the list's top row, and not on a thread's", async () => {
    const comments = client([thread(1)]);
    const wrapper = keep(mount(CommentPanel, {
      global,
      props: { client: comments, subject: pricing },
      slots: { "list-actions": () => h("button", { class: "close-panel" }, "Close") },
    }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    expect(wrapper.find("[data-slot=comment-panel-header] [data-slot=comment-panel-actions] .close-panel").exists()).toBe(true);
    // The box shows no avatar: whoever writes is the reader.
    expect(wrapper.find("[data-slot=comment-panel-composer] [data-slot=avatar-stack]").exists()).toBe(false);

    await wrapper.get("[data-slot=comment-panel-item]").trigger("click");
    await flushPromises();
    expect(wrapper.find(".close-panel").exists()).toBe(false);
  });
});

describe("layer draft uploads", () => {
  it.each([false, true])("guards an upload and ignores a replaced draft=%s", async (replace) => {
    let finish!: (keys: string[]) => void;
    const upload = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const comments = client();
    const create = vi.spyOn(comments.transport, "create");
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(CommentLayer, { comments: state, upload });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    state.startDraft("page");
    await flushPromises();
    addFiles(wrapper, [new File(["png"], "shot.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("Uploaded shot");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    expect(upload).toHaveBeenCalledTimes(1);
    if (replace) {
      state.cancelDraft();
      await flushPromises();
      state.startDraft("page");
      state.draft.value!.body = "Replacement draft";
    }
    finish(["uploads/shot.png"]);
    await flushPromises();
    expect(create).toHaveBeenCalledTimes(replace ? 0 : 1);
    if (replace) expect(state.draft.value).toMatchObject({ attachments: [], body: "Replacement draft" });
    else expect(comments.threads[0]!.messages[0]!.attachments).toEqual(["uploads/shot.png"]);
  });
});

describe("RPC attachments", () => {
  it.each<Component>([CommentPanel, CommentLayer])("uploads files in $name through the shipped RPC transport", async Component => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { operation, input } = operationRpcRequest(init?.body) as { operation: string, input: { attachments: string[], body: string } };
      return operationRpcResponse(init?.body, { ok: true, value: operation === "comments.list" ? [] : thread(1, {
        messages: [message("message-1", { attachments: input.attachments, body: input.body })],
      }) });
    });
    const transport = createRpcTransport({ fetch });
    const comments = createCommentsClient({ transport, user: ana });
    const upload = vi.fn(async () => ["uploads/shot.png"]);
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(Component, { comments: state, upload });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    if (Component === CommentLayer) {
      state.startDraft("page");
      await flushPromises();
    }
    addFiles(wrapper, [new File(["png"], "shot.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("Uploaded shot");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(upload).toHaveBeenCalledOnce();
    expect(comments.threads[0]!.messages[0]!.attachments).toEqual(["uploads/shot.png"]);
  });

  it.each<Component>([CommentPanel, CommentLayer])("disables uploads in $name when the transport opts out", async Component => {
    const transport = createRpcTransport({ fetch: async (_url, init) => operationRpcResponse(init?.body, { ok: true, value: [] }) });
    transport.supportsAttachments = false;
    const comments = createCommentsClient({ transport, user: ana });
    const upload = vi.fn(async () => ["uploads/shot.png"]);
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(Component, { comments: state, upload });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    if (Component === CommentLayer) {
      state.startDraft("page");
      await flushPromises();
    }
    expect(wrapper.find("input[type=file]").exists()).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("CommentPanel rows", () => {
  async function panel(threads: CommentThreadModel[], props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) {
    const comments = client(threads);
    const wrapper = keep(mount(CommentPanel, { attachTo: document.body, global, props: { client: comments, subject: pricing, ...props }, slots }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    return wrapper;
  }

  it("previews a message as plain text and keeps mention names", async () => {
    const wrapper = await panel([thread(1, { messages: [message("m1", { body: "**Pro** plan for `@Ben Soto`, see [docs](https://x.test)", mentions: ["ben"] })] })]);
    expect(wrapper.get("[data-slot=comment-list-text]").text()).toBe("Pro plan for @Ben Soto, see docs");
  });

  it("previews the quoted text when the first message has no text", async () => {
    const wrapper = await panel([thread(1, { anchor: { exact: "Pricing table", kind: "text" } as CommentThreadModel["anchor"], messages: [message("m1", { body: "" })] })]);
    expect(wrapper.get("[data-slot=comment-list-text]").text()).toBe("Pricing table");
  });

  it("takes a preview and a row slot with the thread", async () => {
    const preview = await panel([thread(1)], {}, { preview: ({ thread: item }: { thread: CommentThreadModel }) => h("em", `Note ${item.n}`) });
    expect(preview.get("[data-slot=comment-list-text]").html()).toContain("<em>Note 1</em>");
    const row = await panel([thread(1)], {}, { row: ({ thread: item }: { thread: CommentThreadModel }) => h("span", { class: "own" }, `Row ${item.n}`) });
    expect(row.get("[data-slot=comment-panel-item]").text()).toBe("Row 1");
    expect(row.find("[data-slot=comment-list-number]").exists()).toBe(false);
  });

  it("gives the row slots the default text, so a preview slot keeps it for the rows it does not change", async () => {
    const suggestion = thread(2, { messages: [message("m2", { body: "" })], metadata: { suggestion: "Starter" } });
    const wrapper = await panel([thread(1, { messages: [message("m1", { body: "**Pro** plan" })] }), suggestion], {}, {
      preview: ({ thread: item, text }: CommentRowSlotScope) => (item.metadata?.suggestion ? h("ins", String(item.metadata.suggestion)) : text),
    });
    const texts = Object.fromEntries(wrapper.findAll("[data-slot=comment-panel-item]").map((row) => [row.attributes("data-thread-id"), row.get("[data-slot=comment-list-text]").html()]));
    expect(texts["thread-1"]).toContain(">Pro plan<");
    expect(texts["thread-2"]).toContain("<ins>Starter</ins>");
  });

  it("groups rows under headings after the threads without a group", async () => {
    const group = (item: CommentThreadModel) => (item.n < 3 ? "From earlier versions" : undefined);
    const wrapper = await panel([thread(1), thread(2), thread(3)], { group });
    const sections = wrapper.findAll("[data-slot=comment-panel-groups] > *");
    expect(sections.map(section => section.attributes("data-slot"))).toEqual(["comment-panel-items", "comment-panel-group"]);
    expect(sections[0]!.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-3"]);
    expect(wrapper.get("[data-slot=comment-panel-group-header]").text()).toBe("From earlier versions");
    expect(sections[1]!.findAll("[data-slot=comment-panel-item]")).toHaveLength(2);

    const custom = await panel([thread(1)], { group }, { "group-header": ({ group: label, threads }: { group: string; threads: CommentThreadModel[] }) => h("span", `${label} (${threads.length})`) });
    expect(custom.get("[data-slot=comment-panel-group-header]").text()).toBe("From earlier versions (1)");
  });
});

describe("icons", () => {
  const UIcon = defineComponent({ setup: (_props, { attrs }) => () => h("span", { "data-icon": attrs.name }) });
  const icons = (wrapper: VueWrapper) => [
    ...wrapper.findAll("button[aria-label]").map(button => `${button.attributes("aria-label")}: ${button.attributes("icon")}`),
    ...wrapper.findAll("[data-icon]").map(icon => `icon: ${icon.attributes("data-icon")}`),
  ];

  it("takes each icon from the app's icon config and follows its changes", async () => {
    const names = ref<Record<string, string>>({ arrowUp: "i-ph-arrow-up", check: "i-ph-check", close: "i-ph-x", delete: "i-ph-trash", edit: "i-ph-pencil", file: "i-ph-file", plus: "i-ph-plus" });
    const wrapper = keep(mount(CommentThread, {
      global: { ...global, components: { ...global.components, UIcon }, plugins: [createViteHubUI({ icons: names })] },
      props: { attachmentUrl: () => "/spec.pdf", onDelete: () => {}, onEdit: () => {}, thread: thread(1, { messages: [message("m1", { attachments: ["spec.pdf"] })] }), user: ana },
    }));
    expect(icons(wrapper)).toEqual(expect.arrayContaining([
      "Resolve: i-ph-check",
      "Close: i-ph-x",
      "Edit: i-ph-pencil",
      "Delete: i-ph-trash",
      "Add attachment: i-ph-plus",
      "Reply: i-ph-arrow-up",
      "icon: i-ph-file",
    ]));
    names.value = { ...names.value, edit: "i-ph-pencil-simple" };
    await flushPromises();
    expect(icons(wrapper)).toContain("Edit: i-ph-pencil-simple");
  });

  it("names the toolbar icons in the same config", () => {
    const Toolbar = defineComponent({
      setup: () => {
        const comments = useComments({ client: client(), subject: pricing });
        return () => h(CommentToolbar, { comments });
      },
    });
    const wrapper = keep(mount(Toolbar, {
      global: { ...global, plugins: [createViteHubUI({ icons: { comment: "i-ph-chat", commentList: "i-ph-list", commentPage: "i-ph-note-pencil" } })] },
    }));
    expect(icons(wrapper)).toEqual(["Comment mode: i-ph-chat", "Comment list, 0 on this page: i-ph-list", "Comment on page: i-ph-note-pencil"]);
  });
});

describe("thread permissions", () => {
  const own = thread(1, { messages: [message("m1", { author: ana }), message("m2", { author: ben, threadId: "thread-1" })] });
  const labels = (wrapper: VueWrapper) => wrapper.findAll("button[aria-label]").map(button => button.attributes("aria-label"));

  it("lets a signed-in user reply and resolve, and edit and delete their own messages", () => {
    const wrapper = keep(mount(CommentThread, { global, props: { onDelete: () => {}, onEdit: () => {}, thread: own, user: ana } }));
    expect(labels(wrapper)).toEqual(expect.arrayContaining(["Resolve", "Edit", "Delete"]));
    expect(wrapper.findAll("[data-slot=comment-reply-actions]")).toHaveLength(1);
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(true);
  });

  it("shows no controls to a reader without a user", () => {
    const wrapper = keep(mount(CommentThread, { global, props: { onDelete: () => {}, onEdit: () => {}, thread: own } }));
    expect(labels(wrapper)).not.toContain("Resolve");
    expect(wrapper.find("[data-slot=comment-reply-actions]").exists()).toBe(false);
    expect(wrapper.find("[data-slot=comment-composer]").exists()).toBe(false);
  });

  it("follows the can prop over the comments state", () => {
    const can = (action: string) => action === "reply" || action === "delete";
    const wrapper = keep(mount(CommentThread, { global, props: { can, onDelete: () => {}, onEdit: () => {}, thread: own, user: ana } }));
    expect(labels(wrapper)).not.toContain("Resolve");
    expect(labels(wrapper)).not.toContain("Edit");
    expect(labels(wrapper).filter(label => label === "Delete")).toHaveLength(2);
  });

  it("takes can from useComments() inside a layer or panel", async () => {
    const comments = createCommentsClient({ transport: createMemoryTransport({ threads: [own], user: ben, users: [ana, ben] }), user: ben });
    const wrapper = keep(mount(defineComponent({
      setup() {
        // Only the author of a thread resolves it, and nobody deletes.
        const state = useComments({ can: (action, { thread: item }) => (action === "resolve" ? item.author.id === ben.id : action !== "delete"), client: comments, subject: pricing });
        return () => h(CommentPanel, { comments: state, thread: "thread-1" });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-thread]").exists()).toBe(true));
    expect(labels(wrapper)).not.toContain("Resolve");
    expect(labels(wrapper)).toContain("Edit");
    expect(labels(wrapper)).not.toContain("Delete");
    expect(wrapper.find("[data-slot=comment-thread] [data-slot=comment-composer]").exists()).toBe(true);
  });
});

describe("review fixes", () => {
  it.each(["https://files.test/notes.txt", "/files/notes.txt", "blob:https://files.test/notes"])("keeps a supported attachment URL: %s", (url) => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: { attachmentUrl: () => url, message: message("m1", { attachments: ["notes.txt"] }) },
    }));
    expect(wrapper.get("[data-slot=comment-reply-attachments] a").attributes("href")).toBe(url);
  });

  it.each(["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>"])("renders an unsafe attachment URL as a file name: %s", (url) => {
    const wrapper = keep(mount(CommentReply, {
      global,
      props: { attachmentUrl: () => ({ name: "notes.txt", url }), message: message("m1", { attachments: ["notes"] }) },
    }));
    expect(wrapper.find("[data-slot=comment-reply-attachments] a").exists()).toBe(false);
    expect(wrapper.get("[data-slot=comment-reply-attachments]").text()).toBe("notes.txt");
  });

  it("keeps the submitted files fixed while a layer comment is being created", async () => {
    const comments = client();
    const create = comments.transport.create.bind(comments.transport);
    let finish!: () => void;
    vi.spyOn(comments.transport, "create").mockImplementation(async (input) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return create(input);
    });
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(CommentLayer, { comments: state, upload: async () => ["uploads/shot.png"] });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    state.startDraft("page");
    await flushPromises();
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    addFiles(wrapper, [shot]);
    await wrapper.get("textarea").setValue("Uploaded shot");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get("input[type=file]").attributes("disabled")).toBeDefined();
    expect(wrapper.get("[aria-label='Remove shot.png']").attributes("disabled")).toBeDefined();
    addFiles(wrapper, [new File(["text"], "new.txt")]);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [new File(["text"], "dropped.txt")], types: ["Files"] } });
    wrapper.get("[data-slot=comment-composer]").element.dispatchEvent(drop);
    await flushPromises();
    expect(wrapper.getComponent(CommentComposer).props("files")).toEqual([shot]);
    finish();
    await flushPromises();
    expect(state.draft.value).toBeNull();
    expect(comments.threads[0]!.messages[0]!.attachments).toEqual(["uploads/shot.png"]);
  });

  it("marks a mention whose name changed case after it was picked", async () => {
    const wrapper = keep(mount(CommentReply, { global, props: { message: message("m1", { body: "Hi @ben soto", mentions: ["ben"] }), people: [ben] } }));
    await vi.waitFor(() => expect(wrapper.find("[data-slot=comment-mention]").exists()).toBe(true));
    expect(wrapper.get("[data-slot=comment-mention]").text()).toBe("@Ben Soto");
  });

  it("keeps the menu closed when a lookup that Esc overtook comes back", async () => {
    let finish!: (people: CommentUser[]) => void;
    const users = vi.fn((query: string) => (query === "b" ? Promise.resolve([ben]) : new Promise<CommentUser[]>(resolve => { finish = resolve; })));
    const wrapper = keep(mount(CommentComposer, { attachTo: document.body, global, props: { autofocus: false, guard: false, users } }));
    const field = wrapper.get("textarea");
    await field.setValue("@b");
    await vi.waitFor(() => expect(wrapper.find("[role=listbox]").exists()).toBe(true));
    await field.setValue("@be");
    await field.trigger("keydown", { key: "Escape" });
    finish([ben]);
    await flushPromises();
    expect(wrapper.find("[role=listbox]").exists()).toBe(false);
  });

  it("does not send a layer draft that changed during its upload", async () => {
    let finish!: (keys: string[]) => void;
    const upload = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const comments = client();
    const create = vi.spyOn(comments.transport, "create");
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(CommentLayer, { comments: state, upload });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    state.startDraft("page");
    await flushPromises();
    addFiles(wrapper, [new File(["png"], "shot.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("First text");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("textarea").setValue("Second text");
    finish(["uploads/shot.png"]);
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(state.draft.value).toMatchObject({ body: "Second text" });
  });

  it("does not post a panel comment to the next subject, and empties the box for it", async () => {
    let finish!: (keys: string[]) => void;
    const upload = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const comments = client();
    const create = vi.spyOn(comments.transport, "create");
    const subject = ref(pricing);
    const wrapper = keep(mount(defineComponent({
      setup: () => () => h(CommentPanel, { client: comments, subject: subject.value, upload }),
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    addFiles(wrapper, [new File(["png"], "shot.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("About pricing");
    await wrapper.get("form").trigger("submit");
    subject.value = { id: "/about", kind: "page" };
    await flushPromises();
    finish(["uploads/shot.png"]);
    await flushPromises();
    expect(create).not.toHaveBeenCalled();
    expect(wrapper.get("textarea").element).toHaveProperty("value", "");
  });

  it("lets the next subject send while an upload for the old one never settles", async () => {
    const upload = vi.fn((files: File[]) => (files[0]!.name === "stuck.png" ? new Promise<string[]>(() => {}) : Promise.resolve(files.map(file => `uploads/${file.name}`))));
    const comments = client();
    const subject = ref(pricing);
    const wrapper = keep(mount(defineComponent({
      setup: () => () => h(CommentPanel, { client: comments, subject: subject.value, upload }),
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    addFiles(wrapper, [new File(["png"], "stuck.png", { type: "image/png" })]);
    await wrapper.get("textarea").setValue("About pricing");
    await wrapper.get("form").trigger("submit");
    subject.value = { id: "/about", kind: "page" };
    await flushPromises();
    await wrapper.get("textarea").setValue("About us");
    await wrapper.get("form").trigger("submit");
    await vi.waitFor(() => expect(comments.threads.map(item => item.messages[0]!.body)).toEqual(["About us"]));
    expect(comments.threads[0]!.subject).toEqual({ id: "/about", kind: "page" });
  });

  it("sends a reply of files alone through a client", async () => {
    const comments = client([thread(1)]);
    await comments.start();
    await comments.reply({ attachments: ["uploads/shot.png"], body: "", threadId: "thread-1" });
    expect(comments.threads[0]!.messages.at(-1)).toMatchObject({ attachments: ["uploads/shot.png"], body: "" });
  });
});

describe("agent messages and replies since resolved", () => {
  const claude = { id: "claude-code", image: "/agents/claude.svg", name: "Claude" };
  const resolvedBy = { status: "resolved" as const, resolvedAt: 2_000, resolvedBy: ana };

  it("shows an agent's message as the agent with the person beside it, and its logo", () => {
    const wrapper = keep(mount(CommentThread, {
      attachTo: document.body,
      global,
      props: { thread: thread(1, { messages: [message("m1"), message("m2", { actor: claude, createdAt: 1_500 })] }), user: ana },
    }));
    const authors = wrapper.findAll("[data-slot=comment-reply-author]");
    expect(authors.map(author => author.text())).toEqual(["Ana Ruiz", "Claude (Ana Ruiz)"]);
    expect(authors[1]!.attributes("data-agent")).toBe("true");
    const images = wrapper.findAll("[data-slot=comment-reply] [data-slot=avatar-stack-image]");
    expect(images.map(image => image.attributes("src"))).toEqual(["/agents/claude.svg"]);
  });

  it("puts a reply since the thread was resolved below the Resolved line, and offers Resolve again", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const later = thread(1, { ...resolvedBy, messages: [message("m1"), message("m2", { actor: claude, createdAt: 3_000 })] });
    const wrapper = keep(mount(CommentThread, { attachTo: document.body, global, props: { onResolve, thread: later, user: ana } }));
    const messages = wrapper.get("[data-slot=comment-thread-messages]").element;
    expect([...messages.children].map(child => child.getAttribute("data-slot"))).toEqual(["comment-reply", "marker", "comment-reply"]);
    expect(messages.children[1]!.textContent).toBe("Resolved by Ana Ruiz");
    await wrapper.get("[aria-label=Resolve]").trigger("click");
    expect(onResolve).toHaveBeenCalledOnce();

    const quiet = thread(2, { ...resolvedBy, messages: [message("m3"), message("m4", { createdAt: 1_500 })] });
    const done = keep(mount(CommentThread, { attachTo: document.body, global, props: { thread: quiet, user: ana } }));
    expect(done.find("[aria-label=Reopen]").exists()).toBe(true);
    expect([...done.get("[data-slot=comment-thread-messages]").element.children].at(-1)?.textContent).toContain("Resolved by Ana Ruiz");
  });

  it("lists a resolved thread with a later reply under Open, and as resolved under Resolved", async () => {
    const comments = client([
      thread(1),
      thread(2, { ...resolvedBy, messages: [message("m2"), message("m3", { actor: claude, createdAt: 3_000 })] }),
      thread(3, { ...resolvedBy }),
    ]);
    const wrapper = keep(mount(CommentPanel, { attachTo: document.body, global, props: { client: comments, subject: pricing } }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    expect(wrapper.findAll("[data-slot=comment-panel-filter]").map(button => button.text())).toEqual(["Open 2", "Resolved 2"]);
    const sections = wrapper.findAll("[data-slot=comment-panel-groups] > *");
    expect(sections[0]!.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-1"]);
    expect(wrapper.get("[data-slot=comment-panel-group-header]").text()).toBe("Replied since resolved");
    expect(sections[1]!.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-2"]);

    await wrapper.findAll("[data-slot=comment-panel-filter]")[1]!.trigger("click");
    expect(wrapper.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-2", "thread-3"]);
    expect(wrapper.find("[data-slot=comment-panel-group-header]").exists()).toBe(false);
  });

  it("keeps a replied-to thread ungrouped when the app's grouper returns undefined", async () => {
    const comments = client([
      thread(1),
      thread(2, { ...resolvedBy, messages: [message("m2"), message("m3", { createdAt: 3_000 })] }),
    ]);
    const group = (item: CommentThreadModel) => item.status === "open" ? "Current" : undefined;
    const wrapper = keep(mount(CommentPanel, { attachTo: document.body, global, props: { client: comments, group, subject: pricing } }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    const sections = wrapper.findAll("[data-slot=comment-panel-groups] > *");
    expect(sections.map(section => section.attributes("data-slot"))).toEqual(["comment-panel-items", "comment-panel-group"]);
    expect(sections[0]!.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-2"]);
    expect(wrapper.findAll("[data-slot=comment-panel-group-header]").map(header => header.text())).toEqual(["Current"]);
    expect(sections[1]!.findAll("[data-slot=comment-panel-item]").map(row => row.attributes("data-thread-id"))).toEqual(["thread-1"]);
  });
});

describe("composer layout", () => {
  afterEach(() => {
    document.documentElement.style.fontSize = "";
  });

  async function draftLayer(width = 288) {
    // happy-dom has no layout. Supply the measured width, independently of CSS and the root font size.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("data-slot") === "comment-layer-popover" ? width : 0;
    });
    const comments = client();
    let state!: ReturnType<typeof useComments>;
    const wrapper = keep(mount(defineComponent({
      setup() {
        state = useComments({ client: comments, subject: pricing });
        return () => h(CommentLayer, { comments: state });
      },
    }), { attachTo: document.body, global }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    return { state, wrapper };
  }

  it("puts the reply box of a thread and the box of a panel on one row, and leaves a standalone box bordered", async () => {
    const reply = keep(mount(CommentThread, { attachTo: document.body, global, props: { thread: thread(1), user: ana } }));
    expect(reply.get("[data-slot=comment-thread] > [data-slot=comment-composer]").attributes("data-layout")).toBe("row");

    const comments = client([thread(1)]);
    const panel = keep(mount(CommentPanel, { attachTo: document.body, global, props: { client: comments, subject: pricing } }));
    await vi.waitFor(() => expect(comments.status).toBe("ready"));
    await flushPromises();
    expect(panel.get("[data-slot=comment-panel-composer] > [data-slot=comment-composer]").attributes("data-layout")).toBe("row");

    const box = (layout?: "row") =>
      keep(mount(withState(() => h(CommentComposer, { autofocus: false, guard: false, layout })), { attachTo: document.body, global }))
        .get("[data-slot=comment-composer]").attributes("data-layout");
    expect(box()).toBe("box");
    expect(box("row")).toBe("row");
  });

  it("opens a new comment on the layer as a one-line bubble", async () => {
    const { state, wrapper } = await draftLayer();
    state.startDraft("page");
    await flushPromises();
    expect(wrapper.get("[data-draft=true] > [data-slot=comment-layer-popover] > [data-slot=comment-composer]").attributes("data-layout")).toBe("row");
  });

  it.each([
    { viewport: 375, rem: 16, x: 50, left: 58, flipped: false },
    { viewport: 375, rem: 16, x: 100, left: 79, flipped: false },
    { viewport: 375, rem: 16, x: 250, left: 8, flipped: true },
    { viewport: 375, rem: 16, x: 350, left: 54, flipped: true },
    { viewport: 1024, rem: 16, x: 700, left: 708, flipped: false },
    { viewport: 1024, rem: 16, x: 900, left: 604, flipped: true },
    { viewport: 240, rem: 16, x: 100, left: 8, flipped: false },
    { viewport: 400, rem: 20, x: 50, left: 30, flipped: false },
    { viewport: 375, rem: 16, width: 300, x: 100, left: 67, flipped: false },
    { viewport: 375, rem: 10, width: 300, x: 180, left: 70, flipped: false },
  ])("keeps a draft at x=$x within a $viewport px viewport ($rem px root font)", async ({ viewport, rem, width = Math.min(18 * rem, viewport - rem), x, left, flipped }) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewport);
    document.documentElement.style.fontSize = `${rem}px`;
    const { state, wrapper } = await draftLayer(width);
    const target = document.createElement("div");
    document.body.append(target);
    state.startDraft(target, { point: { x, y: 100 } });
    await flushPromises();
    const item = wrapper.get<HTMLElement>("[data-draft=true]");
    const popover = item.get<HTMLElement>("[data-slot=comment-layer-popover]");
    expect(item.attributes("data-flip-x")).toBe(flipped ? "true" : undefined);
    expect(Number.parseFloat(item.element.style.left)).toBe(x);
    expect(x + Number.parseFloat(popover.element.style.left)).toBe(left);
  });

  it.each([375, 1024])("centers the page draft's bubble in a %s px viewport", async (viewport) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(viewport);
    const { state, wrapper } = await draftLayer();
    state.startDraft("page");
    await flushPromises();
    const item = wrapper.get<HTMLElement>("[data-draft=true]");
    const popover = item.get<HTMLElement>("[data-slot=comment-layer-popover]");
    expect(Number.parseFloat(item.element.style.left) + Number.parseFloat(popover.element.style.left) + 144).toBe(viewport / 2);
  });

  it("draws attach as a ghost icon in a row box and as an outlined button in a bordered one", () => {
    const attach = (layout?: "row") =>
      keep(mount(withState(() => h(CommentComposer, { autofocus: false, guard: false, layout })), { attachTo: document.body, global }))
        .get('button[aria-label="Add attachment"]').attributes("variant");
    expect(attach()).toBe("outline");
    expect(attach("row")).toBe("ghost");
  });
});
