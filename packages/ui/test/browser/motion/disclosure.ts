// The disclosure and panel page of the motion layer of `@vite-hub/ui/motion`: a `<details>` chevron, an `aria-expanded`
// chevron, a panel that opens beside the page, as the Console has them, the Open and Resolved filters of CommentPanel,
// and the disclosures of the docs site. `test/browser/motion-disclosure.browser.mjs` drives it. `?mode=today` turns the
// layer off and gives the page the CSS transitions of the Console and the docs before the layer, to record both.
import "@fontsource-variable/geist";

import { forceReducedMotion, installMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./disclosure.css";

const today = new URLSearchParams(location.search).get("mode") === "today";
document.documentElement.dataset.mode = today ? "today" : "spring";
if (!today) installMotion();

const expand = document.querySelector<HTMLButtonElement>("#expand")!;
const body = document.querySelector<HTMLElement>("#expand-body")!;
expand.addEventListener("click", () => {
  const open = expand.getAttribute("aria-expanded") !== "true";
  expand.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
});

const expanded = document.querySelector<HTMLButtonElement>("#expanded")!;
expanded.addEventListener("click", () => {
  const open = expanded.getAttribute("aria-expanded") !== "true";
  expanded.setAttribute("aria-expanded", String(open));
  document.querySelector<HTMLElement>("#expanded-panel")!.hidden = !open;
});

const panel = document.querySelector<HTMLElement>("#panel")!;
function togglePanel(): void {
  panel.toggleAttribute("data-open");
}
document.querySelector("#toggle-panel")!.addEventListener("click", togglePanel);

for (const radio of document.querySelectorAll<HTMLButtonElement>("[role=radio]")) {
  radio.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[role=radio]")) other.setAttribute("aria-checked", String(other === radio));
  });
}

await document.fonts.ready;
Object.assign(window, {
  ready: true,
  togglePanel,
  setSlow: (factor: number) => setMotionSlowFactor(factor),
  setReduced: (value: boolean | undefined) => forceReducedMotion(value),
  forceReducedMotion,
  setMotionSlowFactor,
});
