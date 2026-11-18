import { announce } from "../internal/announce.ts";
import { cubicBezier, playTween } from "./helpers/tween.ts";
import { isMotionOff } from "./layer.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";
import { writeMotionStyle } from "./registry.ts";
import { createSpring, getMotionSlowFactor, onEachFrame } from "./spring.ts";

const svgNs = "http://www.w3.org/2000/svg";
// The numbers of the prototype's hold to delete. The fill takes 1.1s to fill and 0.35s to empty, and the lid opens by
// 24° with it. At the end the lid opens to 78° in 220ms, each letter jumps into the can (460ms + 10ms a letter, 42ms
// apart, after 140ms), and the lid snaps shut in 300ms. 340ms later the label types "Undo" and the fill fades in 260ms.
// The width of the button follows the label on a (380, 32) spring, and each new letter blurs in from 6px in 240ms.
const fillSeconds = 1.1;
const emptySeconds = 0.35;
const lidHold = -24;
const lidOpen = -78;
const widthSpring = { stiffness: 380, damping: 32 };
const lidOpenEasing = cubicBezier(0.3, 1.5, 0.5, 1);
const riseEasing = cubicBezier(0.2, 0.7, 0.4, 1);
const fallEasing = cubicBezier(0.6, 0, 0.9, 0.5);
const easeIn = cubicBezier(0.42, 0, 1, 1);
// The prototype's dropped file leaves toward its target in 320ms, ease in, down to 20%, with a 3px blur.
const leaveEasing = cubicBezier(0.5, 0, 0.75, 0);
const leavingAttribute = "data-motion-leaving";

export type HoldToDeleteState = "idle" | "holding" | "leaving" | "undo" | "committing";

export interface HoldToDeleteOptions {
  /** The real delete. It runs once, when the Undo window has passed. A rejection brings the item back. */
  commit: () => void | Promise<void>;
  /** The hold is complete: hide the item now. The delete is not done yet. */
  onDelete?: () => void;
  /** Undo, or a commit that failed: show the item again. */
  onUndo?: () => void;
  /** The commit failed. The item is back. */
  onError?: (error: unknown) => void;
  /** Every change of state, such as for a Vue wrapper. */
  onState?: (state: HoldToDeleteState) => void;
  /** The item that leaves toward the trash, such as the row of the button. */
  item?: () => Element | null | undefined;
  /** The label before the hold. Defaults to "Hold to delete". An empty label shows only the trash can. */
  label?: string;
  /** The label of the Undo window. Defaults to "Undo". */
  undoLabel?: string;
  /** How long Undo stays, in milliseconds. Defaults to 5000. */
  undoFor?: number;
  /**
   * The plain path for assistive technology: a click that is not a hold, such as from a screen reader, asks this first.
   * Defaults to `window.confirm()`.
   */
  confirm?: () => boolean | Promise<boolean>;
}

export interface HoldToDelete {
  readonly state: HoldToDeleteState;
  /** Brings the item back during the Undo window. */
  undo(): void;
  /**
   * Stops the helper and restores the button. When the item already left and Undo shows, the delete commits now: the
   * person deleted it and did not undo. A hold that is not complete is cancelled.
   */
  destroy(): void;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** A trash can with a lid that opens on its left corner. */
function trashCan(): { can: SVGSVGElement; lid: SVGGElement } {
  const can = svg("svg", { "aria-hidden": "true", "data-part": "can", fill: "none", height: "16", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": "2", viewBox: "0 0 24 24", width: "16" });
  const lid = svg("g", { "data-part": "lid" });
  lid.append(svg("path", { d: "M3 6h18" }), svg("path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }));
  can.append(lid, svg("path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }));
  Object.assign(can.style, { flex: "none", overflow: "visible" });
  Object.assign(lid.style, { transformBox: "fill-box", transformOrigin: "0% 100%" });
  return { can, lid };
}

const center = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/**
 * Hold to delete of docs/design/motion.md: "Something is deleted and the delete can be undone". It draws into `button`:
 * a fill that grows while the button is held and empties when it is let go early, and a trash can whose lid lifts with
 * it. A complete hold calls `onDelete`, the letters of the label jump into the can, the item leaves toward it, and the
 * button turns into Undo for `undoFor` ms. The real delete, `commit`, runs only when that window has passed.
 *
 * A pointer or Space or Enter held on the button holds it. A click that is not a hold, such as from a screen reader,
 * asks `confirm` and then deletes with the same Undo. Leaving the page or `destroy()` during the Undo window commits.
 * Under reduced motion the fill still shows the hold, but the lid, the letters, and the item do not travel: the label
 * cross-fades. Inside `data-motion="none"` the label changes at once.
 */
export function createHoldToDelete(button: HTMLElement, options: HoldToDeleteOptions): HoldToDelete {
  const label = options.label ?? "Hold to delete";
  const undoLabel = options.undoLabel ?? "Undo";
  const undoFor = options.undoFor ?? 5000;
  const fill = document.createElement("span");
  fill.dataset.part = "fill";
  fill.setAttribute("aria-hidden", "true");
  Object.assign(fill.style, {
    background: "var(--vh-hold-fill, color-mix(in oklch, var(--vh-error, var(--ui-error, currentColor)) 14%, transparent))",
    borderRadius: "inherit",
    clipPath: "inset(0 calc((1 - var(--vh-hold, 0)) * 100%) 0 0 round 6px)",
    inset: "-1px",
    pointerEvents: "none",
    position: "absolute",
  });
  const content = document.createElement("span");
  content.dataset.part = "label";
  Object.assign(content.style, { alignItems: "center", display: "inline-flex", gap: "inherit", position: "relative" });
  const { can, lid } = trashCan();
  const text = document.createElement("span");
  text.dataset.part = "text";
  Object.assign(text.style, { whiteSpace: "pre" });
  content.append(can, text);
  if (getComputedStyle(button).position === "static") button.style.position = "relative";
  button.style.userSelect = "none";
  button.style.setProperty("-webkit-user-select", "none");
  button.style.whiteSpace = "nowrap";
  button.dataset.slot ??= "hold-to-delete";
  button.replaceChildren(fill, content);

  let state: HoldToDeleteState = "idle";
  let hold = 0;
  let direction = 0;
  let stopHold: (() => void) | undefined;
  let stopTweens: Array<() => void> = [];
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  // The state when the pointer or key press started, until its click has passed.
  let pressStart: HoldToDeleteState | undefined;
  let destroyed = false;
  const still = () => prefersReducedMotion() || isMotionOff(button);
  const width = createSpring(0, (value) => {
    button.style.width = width.active ? `${value.toFixed(2)}px` : "";
  }, widthSpring);

  function setState(next: HoldToDeleteState): void {
    state = next;
    button.dataset.state = next;
    options.onState?.(next);
  }

  function natural(): number {
    const current = button.style.width;
    button.style.width = "";
    const value = button.getBoundingClientRect().width;
    button.style.width = current;
    return value;
  }

  // The new letters blur in one after another, and the width of the button follows on its spring.
  function setText(value: string, animate: boolean): void {
    const from = button.getBoundingClientRect().width;
    text.replaceChildren(...[...value].map((letter) => {
      const span = document.createElement("span");
      span.textContent = letter;
      span.style.display = "inline-block";
      return span;
    }));
    text.hidden = value === "";
    if (!animate || isMotionOff(button)) return;
    const to = natural();
    if (prefersReducedMotion()) {
      const fade = playTween(0.15, p => (text.style.opacity = p < 1 ? p.toFixed(3) : ""));
      stopTweens.push(fade.stop);
      return;
    }
    width.set(from);
    button.style.width = `${from}px`;
    width.to(to);
    [...text.children].forEach((letter, index) => {
      if (!(letter instanceof HTMLElement)) return;
      writeMotionStyle(letter, { opacity: "0", filter: "blur(6px)" });
      const tween = playTween(0.24, p => writeMotionStyle(letter, p < 1 ? { opacity: p.toFixed(3), filter: `blur(${(6 * (1 - p)).toFixed(2)}px)` } : { opacity: null, filter: null }), t => t, 0.04 + index * 0.028);
      stopTweens.push(tween.stop);
    });
  }

  function paint(): void {
    button.style.setProperty("--vh-hold", hold.toFixed(4));
    const box = button.getBoundingClientRect();
    const edge = box.left + box.width * hold;
    for (const letter of text.children) {
      if (!(letter instanceof HTMLElement)) continue;
      const rect = letter.getBoundingClientRect();
      letter.style.color = rect.left + rect.width / 2 < edge ? "var(--vh-error, var(--ui-error, currentColor))" : "";
    }
    can.style.color = hold > 0 ? `color-mix(in oklch, var(--vh-error, var(--ui-error, currentColor)) ${Math.min(100, hold * 600).toFixed(1)}%, currentColor)` : "";
    writeMotionStyle(lid, { rotate: !still() && hold > 0 ? `${(lidHold * hold).toFixed(2)}deg` : null });
  }

  function run(next: number): void {
    if (state !== "idle" && state !== "holding") return;
    direction = next;
    if (next > 0) setState("holding");
    if (stopHold) return;
    stopHold = onEachFrame((seconds) => {
      hold = Math.max(0, Math.min(1, hold + seconds * direction / (direction > 0 ? fillSeconds : emptySeconds)));
      paint();
      if (hold >= 1 && direction > 0) {
        stopHold = undefined;
        complete();
        return false;
      }
      if (hold <= 0 && direction < 0) {
        stopHold = undefined;
        setState("idle");
        return false;
      }
      return true;
    });
  }

  // A copy of the item flies into the can, as the prototype's dropped file flies into its drop area.
  function itemLeaves(): Promise<unknown> {
    const item = options.item?.();
    if (!(item instanceof HTMLElement) || still()) return Promise.resolve();
    item.setAttribute(leavingAttribute, "");
    const rect = item.getBoundingClientRect();
    // SAFETY: cloneNode of an HTMLElement returns an HTMLElement.
    const ghost = item.cloneNode(true) as HTMLElement;
    ghost.removeAttribute(leavingAttribute);
    ghost.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    Object.assign(ghost.style, { boxSizing: "border-box", height: `${rect.height}px`, left: `${rect.left}px`, margin: "0", pointerEvents: "none", position: "fixed", top: `${rect.top}px`, width: `${rect.width}px`, zIndex: "2147483646" });
    writeMotionStyle(ghost, { translate: null, scale: null, opacity: null, filter: null });
    document.body.append(ghost);
    const from = center(rect);
    const to = center(can.getBoundingClientRect());
    const tween = playTween(0.32, (p) => {
      writeMotionStyle(ghost, {
        translate: `${((to.x - from.x) * p).toFixed(2)}px ${((to.y - from.y) * p).toFixed(2)}px`,
        scale: (1 - 0.8 * p).toFixed(4),
        opacity: (1 - p).toFixed(3),
        filter: p > 0 ? `blur(${(3 * p).toFixed(2)}px)` : null,
      });
    }, leaveEasing);
    stopTweens.push(tween.stop);
    return tween.done.finally(() => {
      ghost.remove();
      item.removeAttribute(leavingAttribute);
    });
  }

  // The letters jump into the can: up and toward it, then down into it while they shrink and turn.
  function lettersLeave(): Promise<unknown> {
    const target = can.getBoundingClientRect();
    const tx = target.left + target.width / 2;
    const ty = target.top + target.height * 0.35;
    return Promise.all([...text.children].map((letter, index) => {
      if (!(letter instanceof HTMLElement)) return undefined;
      letter.style.color = "var(--vh-error, var(--ui-error, currentColor))";
      const rect = letter.getBoundingClientRect();
      const dx = tx - (rect.left + rect.width / 2);
      const dy = ty - (rect.top + rect.height / 2);
      const lift = -12 - Math.min(18, Math.abs(dx) * 0.14);
      const turn = -15 - index * 4;
      const tween = playTween(0.46 + index * 0.01, (p) => {
        if (p <= 0.55) {
          const e = riseEasing(p / 0.55);
          writeMotionStyle(letter, { translate: `${(dx * 0.5 * e).toFixed(2)}px ${(lift * e).toFixed(2)}px`, rotate: `${(turn * e).toFixed(2)}deg` });
          return;
        }
        const e = fallEasing((p - 0.55) / 0.45);
        writeMotionStyle(letter, {
          translate: `${(dx * 0.5 + dx * 0.5 * e).toFixed(2)}px ${(lift + (dy - lift) * e).toFixed(2)}px`,
          rotate: `${(turn + (-70 - turn) * e).toFixed(2)}deg`,
          scale: (1 - 0.7 * e).toFixed(4),
          opacity: (1 - e).toFixed(3),
        });
      }, t => t, 0.14 + index * 0.042);
      stopTweens.push(tween.stop);
      return tween.done;
    }));
  }

  async function complete(): Promise<void> {
    setState("leaving");
    const leaving = itemLeaves();
    options.onDelete?.();
    if (still()) return toUndo();
    const open = playTween(0.22, p => writeMotionStyle(lid, { rotate: `${(lidHold + (lidOpen - lidHold) * p).toFixed(2)}deg` }), lidOpenEasing);
    stopTweens.push(open.stop);
    await Promise.all([lettersLeave(), leaving]);
    if (state !== "leaving") return;
    // The lid snaps shut: past closed by 5°, then closed.
    const shut = playTween(0.3, (p) => {
      const angle = p <= 0.65 ? lidOpen + (5 - lidOpen) * (p / 0.65) : 5 - 5 * ((p - 0.65) / 0.35);
      writeMotionStyle(lid, { rotate: p < 1 ? `${angle.toFixed(2)}deg` : null });
    }, easeIn);
    stopTweens.push(shut.stop);
    await new Promise(resolve => setTimeout(resolve, 340 * getMotionSlowFactor()));
    if (state === "leaving") toUndo();
  }

  function toUndo(): void {
    if (destroyed) return;
    setState("undo");
    const reset = () => {
      hold = 0;
      button.style.setProperty("--vh-hold", "0");
      fill.style.opacity = "";
      can.style.color = "";
    };
    if (still()) reset();
    else {
      const fade = playTween(0.26, p => (fill.style.opacity = (1 - p).toFixed(3)));
      stopTweens.push(fade.stop);
      void fade.done.then(done => done && reset());
    }
    for (const letter of text.children) if (letter instanceof HTMLElement) letter.style.color = "";
    setText(undoLabel, true);
    announce(button, `Deleted. ${undoLabel} is available.`);
    undoTimer = setTimeout(() => void commit(), undoFor * getMotionSlowFactor());
  }

  function clear(): void {
    stopHold?.();
    stopHold = undefined;
    for (const stop of stopTweens) stop();
    stopTweens = [];
    clearTimeout(undoTimer);
    undoTimer = undefined;
    hold = 0;
    direction = 0;
    fill.style.opacity = "";
    can.style.color = "";
    text.style.opacity = "";
    button.style.setProperty("--vh-hold", "0");
    writeMotionStyle(lid, { rotate: null });
    for (const letter of text.children) if (letter instanceof HTMLElement) letter.style.color = "";
  }

  function toIdle(animate: boolean): void {
    clear();
    setState("idle");
    setText(label, animate);
  }

  async function commit(): Promise<void> {
    if (state !== "undo" && state !== "leaving") return;
    clearTimeout(undoTimer);
    setState("committing");
    try {
      await options.commit();
      if (!destroyed) toIdle(false);
    }
    catch (error) {
      if (!destroyed) toIdle(true);
      options.onUndo?.();
      options.onError?.(error);
    }
  }

  function undo(): void {
    if (state !== "undo" && state !== "leaving") return;
    toIdle(true);
    options.onUndo?.();
  }

  const release = () => {
    if (state === "holding") run(-1);
    // The click of this press comes next in the same task, so it is still known as a press.
    setTimeout(() => (pressStart = undefined));
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pressStart = state;
    if (state === "idle" || state === "holding") run(1);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    pressStart = state;
    if (state === "undo" || state === "leaving") return undo();
    if (state === "idle" || state === "holding") run(1);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") release();
  };
  const onClick = async () => {
    const started = pressStart;
    // The click that ends a complete hold is not an Undo. A new press or a click from a screen reader is.
    if (state === "undo" || state === "leaving") {
      if (started === undefined || started === "undo" || started === "leaving") undo();
      return;
    }
    // A pointer or a key held the button: the hold decides, not the click.
    if (started !== undefined || state !== "idle") return;
    const ok = await (options.confirm ?? (() => window.confirm(`${label || "Delete"}?`)))();
    if (ok && state === "idle") {
      clear();
      complete();
    }
  };
  const onPageHide = () => {
    if (state === "undo" || state === "leaving") void commit();
  };
  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointerleave", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("keydown", onKeyDown);
  button.addEventListener("keyup", onKeyUp);
  button.addEventListener("click", onClick);
  window.addEventListener("pagehide", onPageHide);
  setText(label, false);
  setState("idle");

  return {
    get state() {
      return state;
    },
    undo,
    destroy() {
      if (destroyed) return;
      const pending = state === "undo" || state === "leaving";
      if (pending) void commit();
      destroyed = true;
      clear();
      width.stop();
      button.style.width = "";
      button.removeEventListener("pointerdown", onPointerDown);
      button.removeEventListener("pointerup", release);
      button.removeEventListener("pointerleave", release);
      button.removeEventListener("pointercancel", release);
      button.removeEventListener("keydown", onKeyDown);
      button.removeEventListener("keyup", onKeyUp);
      button.removeEventListener("click", onClick);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}
