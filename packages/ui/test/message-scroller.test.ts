// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "../src/components/agent-chat.ts";
import { createViteHubUI } from "../src/config.ts";
import {
  calculatePrependScrollTop,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerRoot,
  MessageScrollerViewport,
} from "../src/headless/message-scroller.ts";

class ResizeObserverStub {
  disconnect() {}
  observe() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

describe("message scroller behavior", () => {
  it("applies package-wide defaults to the styled chat", () => {
    const wrapper = mount(AgentChat, {
      global: {
        plugins: [
          createViteHubUI({
            defaults: { messageScroller: { edgeThreshold: 12, previousItemPeek: 72 } },
          }),
        ],
      },
    });

    expect(wrapper.findComponent(MessageScrollerRoot).props()).toMatchObject({
      edgeThreshold: 12,
      previousItemPeek: 72,
    });
  });

  it("preserves the reader offset when older content prepends", () => {
    expect(calculatePrependScrollTop(240, 800, 1_100)).toBe(540);
  });

  it("shows a jump control away from the live edge and follows on demand", async () => {
    const scrollTo = vi.fn();
    const Harness = defineComponent({
      setup() {
        return () =>
          h(MessageScrollerRoot, null, {
            default: () => [
              h(MessageScrollerViewport, null, {
                default: () =>
                  h(
                    MessageScrollerContent,
                    { items: ["one"] },
                    {
                      default: () =>
                        h(
                          MessageScrollerItem,
                          { messageId: "one" },
                          {
                            default: () => "One",
                          },
                        ),
                    },
                  ),
              }),
              h(MessageScrollerButton),
            ],
          });
      },
    });
    const wrapper = mount(Harness);
    const viewport = wrapper.find("[data-slot='message-scroller-viewport']");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    (viewport.element as HTMLElement).scrollTop = 200;
    await viewport.trigger("scroll");
    const button = wrapper.find("[data-slot='message-scroller-button']");
    expect(button.exists()).toBe(true);
    await button.trigger("click");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 500 });
  });
});
