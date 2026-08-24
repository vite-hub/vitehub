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
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});

describe("message scroller behavior", () => {
  it("labels the keyboard-scrollable transcript and announces added rows", () => {
    const wrapper = mount(MessageScrollerRoot, {
      slots: {
        default: () =>
          h(MessageScrollerViewport, null, {
            default: () => h(MessageScrollerContent),
          }),
      },
    });

    expect(wrapper.get("[data-slot='message-scroller-viewport']").attributes()).toMatchObject({
      "aria-label": "Messages",
      role: "region",
      tabindex: "0",
    });
    expect(wrapper.get("[data-slot='message-scroller-content']").attributes()).toMatchObject({
      "aria-relevant": "additions",
      role: "log",
    });
  });

  it("marks the transcript busy until a streamed response settles", async () => {
    const wrapper = mount(AgentChat, { props: { status: "streaming" } });

    expect(wrapper.get("[data-slot='message-scroller-content']").attributes("aria-busy")).toBe("true");
    await wrapper.setProps({ status: "ready" });
    expect(wrapper.get("[data-slot='message-scroller-content']").attributes("aria-busy")).toBeUndefined();
  });

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

  it("renders root default content once without replacing message bodies", () => {
    const wrapper = mount(AgentChat, {
      global: {
        components: {
          UChatMessage: defineComponent({
            setup(_props, { slots }) {
              return () => h("div", slots.body?.());
            },
          }),
        },
      },
      props: {
        messages: [{ id: "message", parts: [{ text: "Message body", type: "text" }], role: "assistant" }],
      },
      slots: {
        default: () => h("div", { class: "composer" }, "Composer"),
        text: () => h("div", { class: "message-body" }, "Message body"),
      },
    });

    expect(wrapper.findAll(".composer")).toHaveLength(1);
    expect(wrapper.find(".message-body").text()).toBe("Message body");
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
    const wrapper = mount(Harness, { attachTo: document.body });
    const inactiveButton = wrapper.get("[data-slot='message-scroller-button']");
    expect(inactiveButton.attributes()).toMatchObject({
      "data-active": "false",
      hidden: "",
      inert: "",
      tabindex: "-1",
    });
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
    expect(button.attributes("data-active")).toBe("true");
    expect(button.attributes("hidden")).toBeUndefined();
    expect(button.attributes("inert")).toBeUndefined();
    if (!(button.element instanceof HTMLElement)) throw new TypeError("Expected the scroll control to be an HTML element");
    button.element.focus();
    await button.trigger("click");
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 500 });
    expect(document.activeElement).toBe(viewport.element);

    scrollTo.mockClear();
    scrollTop = 300;
    await viewport.trigger("scroll");
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 600 });
    wrapper.unmount();
  });

  it("preserves a consumer-hidden jump control while active", async () => {
    const Harness = defineComponent({
      setup: () => () => h(MessageScrollerRoot, null, {
        default: () => [h(MessageScrollerViewport), h(MessageScrollerButton, { hidden: true })],
      }),
    });
    const wrapper = mount(Harness);
    const viewport = wrapper.get("[data-slot='message-scroller-viewport']");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 200, writable: true },
    });

    await viewport.trigger("scroll");

    const button = wrapper.get("[data-slot='message-scroller-button']");
    expect(button.attributes("data-active")).toBe("true");
    expect(button.attributes("hidden")).toBe("");
  });

  it("uses instant scrolling when reduced motion is requested", async () => {
    const reducedMotion = Object.assign(new EventTarget(), {
      addListener: vi.fn(),
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      removeListener: vi.fn(),
    }) satisfies MediaQueryList;
    const matchMedia = vi.spyOn(globalThis, "matchMedia").mockReturnValue(reducedMotion);
    const scrollTo = vi.fn();
    const Harness = defineComponent({
      setup() {
        return () => h(MessageScrollerRoot, null, {
          default: () => [h(MessageScrollerViewport), h(MessageScrollerButton)],
        });
      },
    });
    const wrapper = mount(Harness);
    const viewport = wrapper.get("[data-slot='message-scroller-viewport']");
    Object.defineProperties(viewport.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 200, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });

    await viewport.trigger("scroll");
    await wrapper.get("[data-slot='message-scroller-button']").trigger("click");

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 500 });
    matchMedia.mockRestore();
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
          if (Number.isFinite(top)) scrollTop = Number(top);
        }),
      },
    });
    await viewport.trigger("scroll");

    const observer = resizeObservers[0]!;
    expect(observer.targets.has(content.element)).toBe(true);
    scrollTo.mockClear();
    scrollTop = 250;
    await viewport.trigger("wheel", { deltaY: -20 });
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

  it("keeps following when a pointer interaction does not scroll", async () => {
    const scrollTo = vi.fn();
    const wrapper = mount(MessageScrollerRoot, {
      slots: { default: () => h(MessageScrollerViewport) },
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

    await viewport.trigger("pointerdown");
    await viewport.trigger("pointerup");
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 600 });
  });

  it("stops following when a cancelled touch gesture scrolls away", async () => {
    const scrollTo = vi.fn();
    const wrapper = mount(MessageScrollerRoot, {
      slots: { default: () => h(MessageScrollerViewport) },
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

    await viewport.trigger("pointerdown");
    await viewport.trigger("pointercancel");
    scrollTop = 250;
    await viewport.trigger("scroll");
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps following for downward wheel input at the live edge", async () => {
    const scrollTo = vi.fn();
    const wrapper = mount(MessageScrollerRoot, {
      slots: { default: () => h(MessageScrollerViewport) },
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

    await viewport.trigger("wheel", { deltaY: 20 });
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 600 });
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

  it("keeps following for forward keyboard navigation at the live edge", async () => {
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

    for (const key of ["ArrowDown", "End", "PageDown"]) await viewport.trigger("keydown", { key });
    expect(onKeydown).toHaveBeenCalledTimes(3);
    scrollHeight = 600;
    resizeObservers[0]!.callback([], resizeObservers[0]!);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 600 });
  });
});
