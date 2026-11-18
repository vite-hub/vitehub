import { isMotionOff } from "../layer.ts";
import { prefersReducedMotion } from "../reduced-motion.ts";
import { createSpring } from "../spring.ts";
import type { Spring } from "../spring.ts";

// The nodes that the helpers add, so the label effect of the layer can tell its own changes from a change of the app.
const ownNodes = new WeakSet<Node>();

export function own<T extends Node>(node: T): T {
  ownNodes.add(node);
  return node;
}

export function isOwnNode(node: Node): boolean {
  return ownNodes.has(node);
}

// A moving letter draws its character with `::before`, so the letters add nothing to `textContent`: the element's text
// is the hidden copy, the final text, at all times. One rule per document or shadow root.
const glyphRule = "[data-motion-glyph]::before{content:attr(data-motion-glyph)}";
const styledRoots = new WeakSet<Node>();

function addGlyphRule(element: Element): void {
  const root = element.getRootNode();
  if (styledRoots.has(root)) return;
  const target = root instanceof ShadowRoot ? root : document.head;
  if (!target) return;
  styledRoots.add(root);
  const style = own(document.createElement("style"));
  style.dataset.motionGlyphs = "";
  style.textContent = glyphRule;
  target.append(style);
}

/** A span that draws one character, or a run of them, without adding to `textContent`. */
export function glyphNode(text: string): HTMLSpanElement {
  const node = own(document.createElement("span"));
  node.dataset.motionGlyph = text;
  node.style.whiteSpace = "pre";
  return node;
}

/** True when the helpers must set the change at once: no layout, or `data-motion="none"`. */
export function motionSkipped(element: Element): boolean {
  return !element.isConnected || typeof requestAnimationFrame !== "function" || isMotionOff(element);
}

export function reduced(): boolean {
  return prefersReducedMotion();
}

// The width spring of the prototype's label: it follows each typed letter and passes its target a little.
const widthSpring = { stiffness: 380, damping: 34 };

// What the frame sets inline while it runs. It puts the values of the app back at the end.
const framed = ["display", "position", "width", "white-space", "box-sizing", "overflow", "justify-content", "vertical-align"] as const;

/**
 * The element of a label or a count while its letters move. The real text stays in a visually hidden copy, so a screen
 * reader, the accessible name of a button, and `textContent` read the final text at all times. The moving letters are
 * `aria-hidden` and draw with `::before`.
 * The width of the element follows the letters with a spring. At the end the element holds plain text again.
 */
export interface GlyphFrame {
  readonly element: HTMLElement;
  /** The `aria-hidden` element that holds the moving letters. */
  readonly holder: HTMLElement;
  readonly width: Spring;
  /** Sets the text of the hidden copy. */
  name(text: string): void;
  /** The width the element has with its letters in flow and no width set, in border-box pixels. */
  natural(): number;
  /** Puts the copy and the letters back, after the app wrote its own text into the element. */
  restore(): void;
  /** Puts plain text back and the inline styles of the app. */
  collapse(text: string): void;
}

const frames = new WeakMap<HTMLElement, GlyphFrame>();

export function frameOf(element: HTMLElement): GlyphFrame | undefined {
  return frames.get(element);
}

/** Starts a frame on the element. `layout` sets how the letters sit while they move. */
export function openFrame(element: HTMLElement, layout: "inline" | "end", onWidthSettle: () => void): GlyphFrame {
  const saved = framed.map(property => [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)] as const);
  const computed = getComputedStyle(element);
  if (layout === "end") {
    element.style.display = computed.display.startsWith("inline") || computed.display === "contents" ? "inline-flex" : "flex";
    element.style.justifyContent = "flex-end";
  }
  else if (computed.display === "inline" || computed.display === "contents") element.style.display = "inline-block";
  if (computed.position === "static") element.style.position = "relative";
  element.style.whiteSpace = "nowrap";
  element.style.boxSizing = "border-box";
  // A label that truncates clips its blur. The letters fit when the morph ends.
  element.style.overflow = "visible";
  addGlyphRule(element);
  const copy = own(document.createElement("span"));
  copy.dataset.motionCopy = "";
  copy.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0";
  const holder = own(document.createElement("span"));
  holder.setAttribute("aria-hidden", "true");
  holder.dataset.motionGlyphs = "";
  holder.style.display = "contents";
  element.replaceChildren(copy, holder);

  // The caller adds the old letters, then sets the width to where it starts with `width.set(frame.natural())`.
  const width = createSpring(0, (value, velocity) => {
    element.style.width = `${value}px`;
    if (velocity === 0 && value === width.target) onWidthSettle();
  }, widthSpring);

  const frame: GlyphFrame = {
    element,
    holder,
    width,
    name(text) {
      copy.textContent = text;
    },
    restore() {
      if (holder.parentNode !== element || copy.parentNode !== element) element.replaceChildren(copy, holder);
    },
    natural() {
      const current = element.style.width;
      element.style.width = "max-content";
      const style = getComputedStyle(element);
      const value = Number.parseFloat(style.width);
      element.style.width = current;
      return value;
    },
    collapse(text) {
      width.stop();
      frames.delete(element);
      element.replaceChildren(own(document.createTextNode(text)));
      for (const [property, value, priority] of saved) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
      if (!element.getAttribute("style")) element.removeAttribute("style");
    },
  };
  frames.set(element, frame);
  return frame;
}

/** Sets the text of an element that has no frame, or ends its frame, at once. */
export function setText(element: HTMLElement, text: string): void {
  const frame = frames.get(element);
  if (frame) frame.collapse(text);
  else if (element.textContent !== text) element.replaceChildren(own(document.createTextNode(text)));
}
