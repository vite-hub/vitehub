// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterSearch } from "../src/components/filter-search.ts";
import {
  ChoicesInput,
  ChoicesInputClear,
  ChoicesInputError,
  ChoicesInputField,
  ChoicesInputStatus,
  type ChoicesInputSource,
  type ChoicesInputState,
} from "../src/headless/choices-input.ts";

// The shape of `useChoices()`, with spies, so a test sets the status by hand.
function source(initial: ChoicesInputState = "idle") {
  const status = ref<ChoicesInputState>(initial);
  const error = ref<Error>();
  const text = ref("");
  const choices = {
    abort: vi.fn(() => {
      status.value = "idle";
    }),
    clear: vi.fn(() => {
      text.value = "";
      error.value = undefined;
      status.value = "idle";
    }),
    error,
    status,
    submit: vi.fn(async () => {}),
    text,
  } satisfies ChoicesInputSource & { text: Ref<string> };
  return choices;
}

const headless = (choices: ChoicesInputSource, fieldAttrs: Record<string, unknown> = {}) =>
  mount(
    defineComponent({
      setup: () => () =>
        h(ChoicesInput, { choices }, () => [
          h(ChoicesInputField, { label: "Filter demand", ...fieldAttrs }),
          h(ChoicesInputClear),
          h(ChoicesInputStatus),
          h(ChoicesInputError),
        ]),
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChoicesInput parts", () => {
  it("labels the input and binds it to the text", async () => {
    const choices = source();
    const wrapper = headless(choices);
    const input = wrapper.get("input");
    expect(input.attributes("aria-label")).toBe("Filter demand");
    await input.setValue("suppliers except vak");
    expect(choices.text.value).toBe("suppliers except vak");
    choices.text.value = "from the app";
    await flushPromises();
    expect(input.element.value).toBe("from the app");
  });

  it("submits on Enter, but not while an input method composes text", async () => {
    const choices = source();
    const wrapper = headless(choices);
    const input = wrapper.get("input");
    await input.trigger("keydown", { isComposing: true, key: "Enter" });
    await input.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(choices.submit).not.toHaveBeenCalled();
    await input.trigger("keydown", { key: "Enter" });
    expect(choices.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["native", "component"])(
    "preserves text and keyboard listeners on a %s field",
    async (kind) => {
      const choices = source();
      const onKeydown = vi.fn();
      const onUpdate = vi.fn();
      const wrapper = headless(choices, {
        as: kind === "native" ? "input" : UInputStand,
        onKeydown,
        ...(kind === "native" ? { onInput: onUpdate } : { "onUpdate:modelValue": onUpdate }),
      });
      const input = wrapper.get("input");
      await input.setValue("suppliers");
      expect(choices.text.value).toBe("suppliers");
      expect(onUpdate).toHaveBeenCalledTimes(1);
      if (kind === "component") expect(onUpdate).toHaveBeenCalledWith("suppliers");
      await input.trigger("keydown", { key: "Enter" });
      expect(onKeydown).toHaveBeenCalledTimes(1);
      expect(choices.submit).toHaveBeenCalledTimes(1);
    },
  );

  it("clears on Escape and aborts a pending request first", async () => {
    const choices = source("thinking");
    choices.text.value = "suppliers";
    const wrapper = headless(choices);
    await wrapper.get("input").trigger("keydown", { key: "Escape" });
    expect(choices.abort).toHaveBeenCalledTimes(1);
    expect(choices.clear).toHaveBeenCalledTimes(1);
    expect(choices.abort.mock.invocationCallOrder[0]).toBeLessThan(choices.clear.mock.invocationCallOrder[0]!);
  });

  it("leaves Escape to the page when there is nothing to clear", async () => {
    const choices = source();
    const wrapper = headless(choices);
    const event = new KeyboardEvent("keydown", { cancelable: true, key: "Escape" });
    wrapper.get("input").element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(choices.clear).not.toHaveBeenCalled();
  });

  it("sets aria-busy only while thinking", async () => {
    const choices = source();
    const wrapper = headless(choices);
    expect(wrapper.get("input").attributes("aria-busy")).toBe("false");
    choices.status.value = "thinking";
    await flushPromises();
    expect(wrapper.get("input").attributes("aria-busy")).toBe("true");
    choices.status.value = "ready";
    await flushPromises();
    expect(wrapper.get("input").attributes("aria-busy")).toBe("false");
  });

  it("announces Thinking, the result, and the error in a polite live region", async () => {
    const choices = source();
    const wrapper = headless(choices);
    const region = wrapper.get('[data-slot="choices-input-status"]');
    expect(region.attributes()).toMatchObject({ "aria-live": "polite", role: "status" });
    expect(region.text()).toBe("");
    choices.status.value = "thinking";
    await flushPromises();
    expect(region.text()).toBe("Thinking");
    choices.status.value = "ready";
    await flushPromises();
    expect(region.text()).toBe("Ready");
    choices.error.value = new Error("The gateway timed out");
    choices.status.value = "error";
    await flushPromises();
    expect(region.text()).toBe("The gateway timed out");
  });

  it("shows the error as text that the input points to", async () => {
    const choices = source();
    const wrapper = headless(choices);
    expect(wrapper.find('[data-slot="choices-input-error"]').exists()).toBe(false);
    expect(wrapper.get("input").attributes("aria-invalid")).toBeUndefined();
    choices.error.value = new Error("The gateway timed out");
    choices.status.value = "error";
    await flushPromises();
    const error = wrapper.get('[data-slot="choices-input-error"]');
    expect(error.text()).toBe("The gateway timed out");
    expect(wrapper.get("input").attributes()).toMatchObject({ "aria-describedby": error.attributes("id"), "aria-invalid": "true" });
  });

  it.each(["native", "component"])(
    "keeps helper descriptions when a %s field enters and leaves the error state",
    async (kind) => {
      const choices = source();
      const wrapper = headless(choices, {
        "aria-describedby": "help constraints",
        as: kind === "native" ? "input" : UInputStand,
      });
      const input = wrapper.get("input");
      expect(input.attributes("aria-describedby")).toBe("help constraints");
      choices.error.value = new Error("Try again");
      choices.status.value = "error";
      await flushPromises();
      const errorId = wrapper.get('[data-slot="choices-input-error"]').attributes("id");
      expect(input.attributes("aria-describedby")).toBe(`help constraints ${errorId}`);
      choices.clear();
      await flushPromises();
      expect(input.attributes("aria-describedby")).toBe("help constraints");
      expect(input.attributes("aria-invalid")).toBeUndefined();
    },
  );

  it.each(["idle", "thinking", "ready", "error"] as const)("puts data-state=%s and a data-slot on every part", async (state) => {
    const choices = source(state);
    choices.error.value = state === "error" ? new Error("Failed") : undefined;
    const wrapper = headless(choices);
    const slots = ["choices-input", "choices-input-field", "choices-input-clear", "choices-input-status"];
    if (state === "error") slots.push("choices-input-error");
    for (const slot of slots) expect(wrapper.get(`[data-slot="${slot}"]`).attributes("data-state"), slot).toBe(state);
  });

  it("clears from the button, and aborts a pending request first", async () => {
    const choices = source("thinking");
    const wrapper = headless(choices);
    await wrapper.get('[data-slot="choices-input-clear"]').trigger("click");
    expect(choices.abort).toHaveBeenCalledTimes(1);
    expect(choices.clear).toHaveBeenCalledTimes(1);
  });

  it("fails with a clear message outside ChoicesInput", () => {
    const error = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => mount(ChoicesInputField)).toThrow(/ChoicesInputField must be used inside ChoicesInput/);
    error.mockRestore();
  });
});

// Nuxt UI's UInput takes `modelValue`, renders the other attributes on its `input`, and has leading and trailing slots.
const UInputStand = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
  emits: ["update:modelValue"],
  setup(props, { attrs, emit, slots }) {
    return () => {
      return h("span", [
        slots.leading?.(),
        h("input", {
          ...attrs,
          onInput: (event: Event) =>
            emit("update:modelValue", (event.target as HTMLInputElement).value),
          value: props.modelValue,
        }),
        slots.trailing?.(),
      ]);
    };
  },
});
const global = {
  components: {
    UButton: defineComponent({ setup: (_props, { attrs }) => () => h("button", { ...attrs, type: "button" }) }),
    UIcon: defineComponent({ setup: (_props, { attrs }) => () => h("i", { ...attrs, "data-icon": "true" }) }),
    UInput: UInputStand,
  },
};

describe("FilterSearch", () => {
  it("renders an input from props and no filter chips", () => {
    const wrapper = mount(FilterSearch, { global, props: { choices: source(), label: "Filter demand", placeholder: "Try: suppliers except vak" } });
    const input = wrapper.get("input");
    expect(input.attributes()).toMatchObject({ "aria-label": "Filter demand", placeholder: "Try: suppliers except vak", size: "md" });
    expect(wrapper.find('[data-slot="choices-input-field"]').exists()).toBe(true);
    expect(wrapper.find('[data-slot*="chip"], [data-slot*="badge"]').exists()).toBe(false);
  });

  it("submits on Enter and clears on Escape through the headless input", async () => {
    const choices = source();
    const wrapper = mount(FilterSearch, { global, props: { choices } });
    const input = wrapper.get("input");
    await input.trigger("keydown", { key: "Enter" });
    expect(choices.submit).toHaveBeenCalledTimes(1);
    await input.setValue("x");
    await input.trigger("keydown", { key: "Escape" });
    expect(choices.clear).toHaveBeenCalledTimes(1);
  });

  it("shows a loading icon while thinking and a clear button when the text is not empty", async () => {
    const choices = source();
    const wrapper = mount(FilterSearch, { global, props: { choices } });
    expect(wrapper.find("button").exists()).toBe(false);
    choices.text.value = "suppliers";
    await flushPromises();
    expect(wrapper.get("button").attributes("aria-label")).toBe("Clear");
    choices.status.value = "thinking";
    await flushPromises();
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.get("[data-icon]").classes()).toContain("animate-spin");
    expect(wrapper.get("input").attributes("aria-busy")).toBe("true");
    expect(wrapper.get('[data-slot="choices-input-status"]').text()).toBe("Thinking");
  });

  it("renders the error and lets the #error slot replace it", async () => {
    const choices = source();
    choices.error.value = new Error("The gateway timed out");
    choices.status.value = "error";
    const plain = mount(FilterSearch, { global, props: { choices } });
    expect(plain.get('[data-slot="choices-input-error"]').text()).toBe("The gateway timed out");
    const custom = mount(FilterSearch, {
      global,
      props: { choices },
      slots: { error: ({ error }: { error: Error | undefined }) => h("strong", `Try again: ${error?.message}`) },
    });
    expect(custom.get('[data-slot="choices-input-error"] strong').text()).toBe("Try again: The gateway timed out");
  });

  it("renders the #leading and #trailing slots", () => {
    const wrapper = mount(FilterSearch, {
      global,
      props: { choices: source() },
      slots: { leading: () => h("b", "L"), trailing: () => h("b", "T") },
    });
    expect(wrapper.findAll("b").map((node) => node.text())).toEqual(["L", "T"]);
  });

  it("makes no network call on its own", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const choices = source();
    const wrapper = mount(FilterSearch, { global, props: { choices } });
    await wrapper.get("input").setValue("suppliers except vak");
    await wrapper.get("input").trigger("keydown", { key: "Enter" });
    choices.status.value = "thinking";
    await flushPromises();
    choices.status.value = "error";
    choices.error.value = new Error("Failed");
    await flushPromises();
    await wrapper.get("input").trigger("keydown", { key: "Escape" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
