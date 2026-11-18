import { isOwnNode, own } from "../helpers/frame.ts";
import { enterIcon, leaveIcon, offsetIn } from "../helpers/icon.ts";
import { morph, morphTarget } from "../helpers/text.ts";
import type { MotionEffect } from "../registry.ts";

const controls = ":is(button, a, [role=button])";

/**
 * Rule 4 for every button: when the label of a Nuxt UI button, or of any control with a `[data-slot=label]` child,
 * changes, its letters morph and the button's width follows. The app only changes the label, such as
 * `:label="loading ? 'Publishing' : 'Publish'"`.
 */
export const label: MotionEffect = {
  name: "label",
  selector: `${controls} > [data-slot=label]`,
  content(element, { added, removed, oldText }) {
    if (!(element instanceof HTMLElement)) return;
    // The morph's own letters, or a change that did not write new text.
    if (added.length ? added.every(isOwnNode) : removed.length > 0) return;
    const before = morphTarget(element) ?? oldText;
    if (before === undefined) return;
    morph(element, element.textContent ?? "", before);
  },
};

/**
 * Rule 5 for every button: when Vue draws another icon into the leading or trailing SVG of a button, such as the
 * spinner of `loading`, a copy of the old icon blurs out where it was and the new one comes in. A spinner draws its
 * stroke. An icon of `@nuxt/icon` in CSS mode changes a class, which the layer does not watch, so it changes at once.
 */
export const buttonIcon: MotionEffect = {
  name: "button-icon",
  selector: `${controls} > svg:is([data-slot=leadingIcon], [data-slot=trailingIcon])`,
  content(svg, { added, removed }) {
    const container = svg.parentElement;
    if (!(svg instanceof SVGSVGElement) || !container || !removed.length || added.every(isOwnNode)) return;
    if (!removed.some(node => node instanceof SVGElement)) return;
    const at = offsetIn(container, svg);
    const ghost = own(svg.cloneNode(false) as SVGSVGElement);
    ghost.classList.remove("animate-spin");
    ghost.removeAttribute("data-slot");
    ghost.append(...removed);
    svg.after(ghost);
    leaveIcon(container, ghost, at, "blur", old => old.remove());
    enterIcon(svg, undefined, 0);
  },
};
