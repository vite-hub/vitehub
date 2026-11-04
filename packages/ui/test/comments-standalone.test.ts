// @vitest-environment happy-dom

import { createCommentsClient, type CommentUser } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, shallowRef } from "vue";
import { useComments, type CommentsState } from "../src/headless/comments.ts";
import { mentionPlugin, splitMentions } from "../src/internal/comment-mentions.ts";
import { Markdown } from "../src/standalone/markdown.ts";

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const sofia: CommentUser = { id: "sofia", name: "Sofía Benítez" };
const pricing = { id: "/pricing", kind: "page" };

afterEach(() => {
  document.body.innerHTML = "";
  getSelection()?.removeAllRanges();
});

describe("splitMentions", () => {
  it("cuts text at whole names, with the rule of the Markdown mention plugin", () => {
    const people = [{ id: "ana", name: "Ana" }, { id: "ana-ruiz", name: "Ana Ruiz" }, { id: "sofia", name: "Sofía Benítez" }];
    expect(splitMentions("@Ana Ruiz and (@Sofía Benítez), not mail@Ana or @Anabel", people)).toEqual([
      { id: "ana-ruiz", name: "Ana Ruiz" },
      " and (",
      { id: "sofia", name: "Sofía Benítez" },
      "), not mail@Ana or @Anabel",
    ]);
    expect(splitMentions("No people", [])).toEqual(["No people"]);
  });
});

describe("the standalone Markdown", () => {
  it("renders the mention chips of the comment parts, and keeps `@` in code", () => {
    const Chip = defineComponent({
      props: { label: { default: "", type: String }, user: { default: "", type: String } },
      setup: props => () => h("span", { "data-slot": "comment-mention", "data-user": props.user }, `@${props.label}`),
    });
    const wrapper = mount(Markdown, {
      props: {
        components: { "comment-mention": Chip },
        plugins: [mentionPlugin([{ id: "sofia", name: "Sofía Benítez" }])],
        value: "**@Sofía Benítez** look at `@Sofía Benítez`\n\nSee https://vitehub.dev",
      },
    });
    const chips = wrapper.findAll('[data-slot="comment-mention"]');
    expect(chips.map(chip => [chip.text(), chip.attributes("data-user")])).toEqual([["@Sofía Benítez", "sofia"]]);
    expect(wrapper.find("strong [data-slot='comment-mention']").exists()).toBe(true);
    expect(wrapper.find("code").text()).toBe("@Sofía Benítez");
    expect(wrapper.find("a").attributes()).toMatchObject({ href: "https://vitehub.dev", rel: "noopener noreferrer" });
    expect(wrapper.findAll("p")).toHaveLength(2);
  });
});

describe("useComments", () => {
  function withState(options: Partial<Parameters<typeof useComments>[0]> = {}) {
    let state!: CommentsState;
    const client = createCommentsClient({ transport: createMemoryTransport({ threads: [], user: ana, users: [ana] }), user: ana });
    mount(defineComponent({
      setup() {
        state = useComments({ client, subject: pricing, hotkey: false, ...options });
        return () => h("div");
      },
    }));
    return state;
  }

  it("knows the people that the app passes, so their mentions get names", () => {
    const known = shallowRef<CommentUser[]>([]);
    const state = withState({ people: known });
    expect(state.people.value.map(person => person.id)).toEqual(["ana"]);
    known.value = [sofia];
    expect(state.people.value.map(person => person.id)).toEqual(["sofia", "ana"]);
  });

  it("enters comment mode when the selection is no longer on the page", () => {
    const state = withState();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Removed by a router";
    document.body.append(paragraph);
    getSelection()!.selectAllChildren(paragraph);
    paragraph.remove();
    expect(() => state.enter()).not.toThrow();
    expect(state.active.value).toBe(true);
    expect(state.draft.value).toBeNull();
  });
});
