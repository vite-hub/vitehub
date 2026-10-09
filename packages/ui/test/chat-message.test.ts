// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { describe, expect, it } from "vitest";

import { AgentChatMessage } from "../src/components/agent-chat-message.ts";

const UChatMessage = defineComponent({
  props: { role: String, side: String, variant: String },
  setup(props, { slots }) {
    return () => h("article", { "data-role": props.role, "data-side": props.side, "data-variant": props.variant }, [
      slots.body ? h("div", { "data-slot": "body" }, slots.body()) : h("div", { "data-slot": "content" }, slots.content?.()),
    ]);
  },
});
const global = { components: { UChatMessage } };

describe("AgentChatMessage", () => {
  it("places user messages in a bubble on the right and assistant messages as plain text on the left", () => {
    const user = mount(AgentChatMessage, { global, props: { message: { id: "u", parts: [{ text: "Hi", type: "text" }], role: "user" } } });
    const assistant = mount(AgentChatMessage, { global, props: { message: { id: "a", parts: [{ text: "Hello", type: "text" }], role: "assistant" } } });

    expect(user.get("article").attributes()).toMatchObject({ "data-side": "right", "data-variant": "soft" });
    expect(assistant.get("article").attributes()).toMatchObject({ "data-side": "left", "data-variant": "naked" });
  });

  it("renders the parts inside the content slot and a default slot as the whole body", () => {
    const message = { id: "a", parts: [{ text: "Hello", type: "text" as const }], role: "assistant" as const };
    const parts = mount(AgentChatMessage, { global, props: { message } });
    const body = mount(AgentChatMessage, { global, props: { message }, slots: { default: () => h("em", "Custom") } });

    expect(parts.get('[data-slot="content"]').text()).toBe("Hello");
    expect(parts.find('[data-slot="body"]').exists()).toBe(false);
    expect(body.get('[data-slot="body"] em').text()).toBe("Custom");
    expect(body.find('[data-slot="content"]').exists()).toBe(false);
  });

  it("lets attributes override the role defaults", () => {
    const wrapper = mount(AgentChatMessage, {
      attrs: { side: "left", variant: "outline" },
      global,
      props: { message: { id: "u", parts: [{ text: "Hi", type: "text" }], role: "user" } },
    });

    expect(wrapper.get("article").attributes()).toMatchObject({ "data-side": "left", "data-variant": "outline" });
  });
});
