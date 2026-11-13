// @vitest-environment happy-dom
import { h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNext,
  StepperPrevious,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@vite-hub/kit/stepper";

import { click, mount, one, press, settle } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const steps = ["Address", "Shipping", "Payment", "Review"];

function render(step: Ref<number>, props: Record<string, unknown> = {}, disabled?: number) {
  const view = mount(() =>
    h(
      Stepper,
      { "aria-label": "Checkout", modelValue: step.value, "onUpdate:modelValue": (value: number) => (step.value = value), ...props },
      () => [
        ...steps.map((title, index) =>
          h(StepperItem, { key: title, value: index + 1, disabled: disabled === index + 1 }, () => [
            h(StepperTrigger, null, () => h(StepperIndicator, null, () => String(index + 1))),
            h(StepperTitle, null, () => title),
            h(StepperDescription, null, () => `Step ${index + 1}`),
            index < steps.length - 1 ? h(StepperSeparator) : null,
          ]),
        ),
        h(StepperPrevious, null, () => "Back"),
        h(StepperNext, null, () => "Next"),
      ],
    ),
  );
  cleanup = view.unmount;
  const triggers = () => [...view.host.querySelectorAll<HTMLButtonElement>('[data-slot="stepper-trigger"]')];
  const items = () => [...view.host.querySelectorAll<HTMLElement>('[data-slot="stepper-item"]')];
  return { ...view, triggers, items };
}

describe("Stepper", () => {
  it("marks each step complete, current, or upcoming, and names each trigger after its title", async () => {
    const { host, items, triggers } = render(ref(2));
    await settle();
    const root = one(host, '[data-slot="stepper"]');
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Checkout");
    expect(items().map((item) => [item.hasAttribute("data-complete"), item.hasAttribute("data-current"), item.hasAttribute("data-upcoming")])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, true],
    ]);
    expect(triggers().map((trigger) => trigger.getAttribute("aria-current"))).toEqual([null, "step", null, null]);
    const name = (trigger: HTMLElement, attribute: string) => document.getElementById(trigger.getAttribute(attribute)!)?.textContent;
    expect(name(triggers()[2]!, "aria-labelledby")).toBe("Payment");
    expect(name(triggers()[2]!, "aria-describedby")).toBe("Step 3");
    expect(host.querySelectorAll('[data-slot="stepper-separator"][aria-hidden="true"]')).toHaveLength(3);
  });

  it("has one tab stop, on the current step, and moves with the arrow keys", async () => {
    const step = ref(2);
    const { triggers } = render(step, { linear: false });
    await settle();
    expect(triggers().map((trigger) => trigger.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
    triggers()[1]!.focus();
    await press(triggers()[1]!, "ArrowRight");
    expect(document.activeElement).toBe(triggers()[2]);
    await press(triggers()[2]!, "ArrowLeft");
    expect(document.activeElement).toBe(triggers()[1]);
    await press(triggers()[1]!, "ArrowDown");
    expect(document.activeElement).toBe(triggers()[1]);
    await click(triggers()[3]!);
    expect(step.value).toBe(4);
    expect(triggers()[3]!.getAttribute("tabindex")).toBe("0");
  });

  it("uses Up and Down when vertical", async () => {
    const { triggers, host } = render(ref(1), { orientation: "vertical", linear: false });
    await settle();
    expect(one(host, '[data-slot="stepper"]').getAttribute("data-orientation")).toBe("vertical");
    triggers()[0]!.focus();
    await press(triggers()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(triggers()[1]);
  });

  it("only goes back or one step ahead when linear", async () => {
    const step = ref(2);
    const { triggers, items } = render(step);
    await settle();
    expect(triggers().map((trigger) => trigger.disabled)).toEqual([false, false, false, true]);
    expect(items()[3]!.hasAttribute("data-disabled")).toBe(true);
    await click(triggers()[3]!);
    expect(step.value).toBe(2);
    await click(triggers()[2]!);
    expect(step.value).toBe(3);
    await click(triggers()[0]!);
    expect(step.value).toBe(1);
  });

  it("never goes to a disabled step", async () => {
    const step = ref(1);
    const { triggers } = render(step, { linear: false }, 3);
    await settle();
    expect(triggers()[2]!.disabled).toBe(true);
    triggers()[1]!.focus();
    await press(triggers()[1]!, "ArrowRight");
    expect(document.activeElement).toBe(triggers()[3]);
  });

  it("goes to the next and previous steps, and disables them at the ends", async () => {
    const step = ref(1);
    const { host } = render(step);
    await settle();
    const back = one<HTMLButtonElement>(host, '[data-slot="stepper-previous"]');
    const next = one<HTMLButtonElement>(host, '[data-slot="stepper-next"]');
    expect(back.disabled).toBe(true);
    await click(next);
    await click(next);
    await click(next);
    expect(step.value).toBe(4);
    expect(next.disabled).toBe(true);
    await click(back);
    expect(step.value).toBe(3);
    expect(back.disabled).toBe(false);
  });
});
