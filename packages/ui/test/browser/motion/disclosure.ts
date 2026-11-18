// The disclosure page: the chevron of a `<details>` or of an `aria-expanded` trigger turns with the motion layer of
// `@vite-hub/ui/motion` when it opens or closes. `?mode=today` keeps the motion layer off and turns the chevrons with
// the CSS transition that the docs had before the layer, to record both.
import { forceReducedMotion, installMotion, setMotionSlowFactor } from "../../../src/motion.ts";
import "./disclosure.css";

const today = new URLSearchParams(location.search).get("mode") === "today";
document.documentElement.dataset.mode = today ? "today" : "spring";
if (!today) installMotion();

const button = document.querySelector<HTMLButtonElement>("#expanded")!;
button.addEventListener("click", () => {
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  document.querySelector<HTMLElement>("#expanded-panel")!.hidden = !open;
});

Object.assign(window, { forceReducedMotion, setMotionSlowFactor, ready: true });
