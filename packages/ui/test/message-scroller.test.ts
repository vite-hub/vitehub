// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
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

class ResizeObserverStub implements ResizeObserver {
  callback: ResizeObserverCallback;
  targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  disconnect() {
    this.targets.clear();
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }
}

class MutationObserverStub {
  constructor(_callback: MutationCallback) {}
  disconnect() {}
  observe() {}
}

const resizeObservers: ResizeObserverStub[] = [];

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("MutationObserver", MutationObserverStub);
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

  it("does not preserve an offset when replacing the message list", async () => {
    const items = ref(["old"]);
    const Harness = defineComponent({
      setup() {
        return () => h(MessageScrollerRoot, null, {
          default: () => h(MessageScrollerViewport, null, {
            default: () => h(MessageScrollerContent, { items: items.value }),
          }),
        });
      },
    });
    const wrapper = mount(Harness);
    const viewport = wrapper.find("[data-slot='message-scroller-viewport']");
    let scrollHeight = 500;
    let scrollTop = 200;
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });
    await viewport.trigger("scroll");

    scrollHeight = 700;
    items.value = ["new"];
    await wrapper.vm.$nextTick();

    expect(scrollTop).toBe(200);
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
    let scrollHeight = 500;
    let scrollTop = 200;
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollTo: { configurable: true, value: scrollTo },
    });
    await viewport.trigger("scroll");
    const button = wrapper.find("[data-slot='message-scroller-button']");
    expect(button.exists()).toBe(true);
    await button.trigger("click");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 500 });

    scrollTo.mockClear();
    scrollTop = 300;
    await viewport.trigger("scroll");
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 600 });
  });

  it("stops following before user scrolling and follows content-only growth at the edge", async () => {
    const scrollTo = vi.fn();
    const Harness = defineComponent({
      setup() {
        return () =>
          h(MessageScrollerRoot, null, {
            default: () =>
              h(MessageScrollerViewport, null, {
                default: () =>
                  h(
                    MessageScrollerContent,
                    { items: ["one"] },
                    {
                      default: () =>
                        h(MessageScrollerItem, { messageId: "one" }, { default: () => "One" }),
                    },
                  ),
              }),
          });
      },
    });
    const wrapper = mount(Harness);
    const viewport = wrapper.find("[data-slot='message-scroller-viewport']");
    const content = wrapper.find("[data-slot='message-scroller-content']");
    let scrollHeight = 500;
    let scrollTop = 400;
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollTo: {
        configurable: true,
        value: scrollTo.mockImplementation(({ top }: ScrollToOptions) => {
          if (typeof top === "number") scrollTop = top;
        }),
      },
    });
    await viewport.trigger("scroll");

    const observer = resizeObservers[0]!;
    expect(observer.targets.has(content.element)).toBe(true);
    scrollTo.mockClear();
    scrollTop = 250;
    await viewport.trigger("wheel");
    await viewport.trigger("scroll");
    scrollHeight = 600;
    observer.callback([], observer);
    expect(scrollTo).not.toHaveBeenCalled();

    scrollTop = 500;
    await viewport.trigger("scroll");
    scrollTo.mockClear();
    scrollHeight = 700;
    observer.callback([], observer);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 700 });
  });

  it("stops following when keyboard input scrolls away from the live edge", async () => {
    const scrollTo = vi.fn();
    const onKeydown = vi.fn();
    const wrapper = mount(MessageScrollerRoot, {
      slots: { default: () => h(MessageScrollerViewport, { onKeydown }) },
    });
    const viewport = wrapper.find("[data-slot='message-scroller-viewport']");
    let scrollHeight = 500;
    let scrollTop = 400;
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } },
      scrollTo: { configurable: true, value: scrollTo },
    });
    await viewport.trigger("scroll");

    await viewport.trigger("keydown", { key: "PageUp" });
    expect(onKeydown).toHaveBeenCalledOnce();
    scrollTop = 200;
    await viewport.trigger("scroll");
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
