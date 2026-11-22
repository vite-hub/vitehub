// The effects that wave 5 added to `@vite-hub/ui/motion`, on plain elements: the disclosure chevron, a mark that
// leaves, an element that appears next to its trigger (`data-motion-appear`), a press that squashes the element that
// draws the control (`data-motion-press-target`), and the shake helper. The test drives each one and reads its frames.
import { forceReducedMotion, installMotion, setMotionSlowFactor, shake } from "../../../src/motion.ts";

installMotion();

const spot = document.querySelector<HTMLElement>("[data-test=spot]")!;

Object.assign(window, {
  setSlow: (factor: number) => setMotionSlowFactor(factor),
  setReduced: (value: boolean | undefined) => forceReducedMotion(value),
  shakeBox: () => shake(document.querySelector<HTMLElement>("[data-test=box]")!),
  /** Adds the draft bubble next to the pin, as the comment layer does. */
  openBubble: () => {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dataset.test = "bubble";
    bubble.setAttribute("data-motion-appear", ".pin");
    bubble.append(Object.assign(document.createElement("span"), { textContent: "A new comment" }));
    spot.append(bubble);
  },
  closeBubble: () => spot.querySelector("[data-test=bubble]")?.remove(),
  /** The angle of a chevron as a person sees it, and what is written inline. */
  chevronAngle: (selector: string) => {
    const chevron = document.querySelector<HTMLElement>(selector)!;
    const rotate = getComputedStyle(chevron).rotate;
    return { inline: chevron.style.rotate, angle: rotate === "none" ? 0 : Number.parseFloat(rotate.split(" ").at(-1)!) };
  },
  /** Presses a control as a person does: pointer down, pointer up, and click. */
  pressControl: (selector: string) => {
    const control = document.querySelector<HTMLElement>(selector)!;
    const init = { bubbles: true, composed: true, isPrimary: true, pointerId: 1, pointerType: "mouse", button: 0 };
    control.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
    control.dispatchEvent(new PointerEvent("pointerup", init));
    control.click();
  },
  leaveMark: () => document.querySelector("[data-test=mark]")!.setAttribute("data-leaving", "true"),
  showMark: () => document.querySelector("[data-test=mark]")!.removeAttribute("data-leaving"),
});

for (const button of document.querySelectorAll<HTMLElement>("[data-test=disclosure], [data-test=off-disclosure]")) {
  button.addEventListener("click", () => button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true")));
}

Object.assign(window, { ready: true });
