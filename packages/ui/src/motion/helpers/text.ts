import { writeMotionStyle } from "../registry.ts";
import { getMotionSlowFactor } from "../spring.ts";
import { frameOf, glyphNode, motionSkipped, openFrame, reduced, setText } from "./frame.ts";
import type { GlyphFrame } from "./frame.ts";
import { easeIn, easeOut, tween } from "./tween.ts";
import type { Tween } from "./tween.ts";

/** How a label changes: the letters it keeps from the start, the letters that leave, and the letters that type in. */
export interface TextDiff {
  kept: string;
  gone: string;
  typed: string;
}

/** Splits a change of label into the shared start, the old letters after it, and the new letters after it. */
export function diffText(from: string, to: string): TextDiff {
  const a = [...from];
  const b = [...to];
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return { kept: a.slice(0, index).join(""), gone: a.slice(index).join(""), typed: b.slice(index).join("") };
}

// The numbers of the prototype's `retype()`: a letter blurs 6px, leaves in 200ms 30ms after the one before it, and
// types in over 240ms, 55ms after the one before it. A label crossfades in 150ms under reduced motion.
const blur = 6;
const leave = { duration: 200, stagger: 30 };
const type = { duration: 240, lead: 30, stagger: 55 };
const crossfade = 150;

interface Letter {
  node: HTMLSpanElement;
  char: string;
  /** 1 when the letter shows, 0 when it is gone. */
  shown: number;
  fade?: Tween;
  /** The letter waits for its turn to type in. */
  waiting: boolean;
}

interface Morph {
  frame: GlyphFrame;
  text: string;
  letters: Letter[];
  leaving: Set<Letter>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const morphs = new WeakMap<HTMLElement, Morph>();

/** The text that the element shows or moves to, when a morph runs on it. */
export function morphTarget(element: HTMLElement): string | undefined {
  return morphs.get(element)?.text;
}

function paint(letter: Letter, value: number, reducedMotion: boolean): void {
  letter.shown = value;
  writeMotionStyle(letter.node, {
    opacity: value >= 1 ? null : String(value),
    filter: reducedMotion || value >= 1 ? null : `blur(${(blur * (1 - value)).toFixed(2)}px)`,
  });
}

function letterNode(char: string): HTMLSpanElement {
  return glyphNode(char);
}

function finishIfIdle(element: HTMLElement, morph: Morph): void {
  if (morphs.get(element) !== morph) return;
  if (morph.leaving.size || morph.timers.size || morph.frame.width.active || morph.letters.some(letter => letter.fade || letter.waiting)) return;
  morphs.delete(element);
  morph.frame.collapse(morph.text);
}

function stopAll(morph: Morph): void {
  for (const timer of morph.timers) clearTimeout(timer);
  morph.timers.clear();
  for (const letter of [...morph.letters, ...morph.leaving]) letter.fade?.stop();
}

/**
 * Changes the text of `element` letter by letter, as rule 4 of docs/design/motion.md asks: the letters that the old and
 * new text share at the start stay, the other old letters blur out where they are, and the new letters type in one at
 * a time with a short blur. The width of the element follows the letters with a spring and never jumps.
 *
 * Call it again at any time: a new text continues from the letters on screen. The element keeps the final text for
 * screen readers during the morph, and holds plain text again when it ends. Under reduced motion the two texts
 * crossfade in 150ms. Inside `data-motion="none"`, or when the element has no layout, it sets the text at once.
 *
 * Give it an element of its own with no padding, such as the label `<span>` of a button.
 */
export function morphText(element: HTMLElement, text: string): void {
  morph(element, text, undefined);
}

function hasLayout(element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    if (node.getClientRects().length) return true;
    if (getComputedStyle(node).display !== "contents") return false;
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

/**
 * The morph of `morphText`. `from` is the text that the element showed before, when the app already wrote the new text
 * into the element, as Vue does with the label of a button.
 */
export function morph(element: HTMLElement, text: string, from: string | undefined): void {
  let current = morphs.get(element);
  const before = current?.text ?? from ?? element.textContent ?? "";
  if (motionSkipped(element) || (!current && before === text) || !hasLayout(element)) {
    if (current) {
      stopAll(current);
      morphs.delete(element);
    }
    setText(element, text);
    return;
  }
  const reducedMotion = reduced();
  if (!current) {
    const frame = frameOf(element) ?? openFrame(element, "inline", () => {
      const running = morphs.get(element);
      if (running) finishIfIdle(element, running);
    });
    const letters = [...before].map((char): Letter => ({ node: letterNode(char), char, shown: 1, waiting: false }));
    frame.holder.append(...letters.map(letter => letter.node));
    frame.width.set(frame.natural());
    current = { frame, text: before, letters, leaving: new Set(), timers: new Set() };
    morphs.set(element, current);
  }
  const state = current;
  const width = state.frame.width;
  state.frame.restore();
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  state.text = text;
  state.frame.name(text);

  if (reducedMotion) {
    // A crossfade: every old letter fades where it is, and the new text fades in as one word.
    leaveLetters(state, state.letters, true);
    state.letters = [...text].map((char): Letter => {
      const letter: Letter = { node: letterNode(char), char, shown: 0, waiting: false };
      paint(letter, 0, true);
      state.frame.holder.append(letter.node);
      return letter;
    });
    width.set(state.frame.natural());
    for (const letter of state.letters) fadeIn(element, state, letter, 0, crossfade, true);
    return;
  }

  // The letters on screen, in order. A letter that waits to type in counts as typed, so a shared start keeps it.
  const shownText = state.letters.map(letter => letter.char).join("");
  const diff = diffText(shownText, text);
  const keptCount = [...diff.kept].length;
  const kept = state.letters.slice(0, keptCount);
  leaveLetters(state, state.letters.slice(keptCount), false);

  // Letters that still wait type in again with the new ones, so the typing continues from where it is.
  const typing = [...kept.filter(letter => letter.waiting), ...[...diff.typed].map((char): Letter => {
    const letter: Letter = { node: letterNode(char), char, shown: 0, waiting: true };
    paint(letter, 0, false);
    state.frame.holder.append(letter.node);
    return letter;
  })];
  state.letters = [...kept, ...typing.filter(letter => !kept.includes(letter))];
  const end = state.frame.natural();
  if (!typing.length) {
    width.to(end);
    return;
  }
  // The width grows letter by letter. The first step does not shrink the element below where it is, unless it ends
  // smaller, so a label that loses letters and gains others does not pinch in between.
  const start = width.value;
  let step = end - typing.reduce((sum, letter) => sum + letter.node.offsetWidth, 0);
  const slow = getMotionSlowFactor();
  typing.forEach((letter, index) => {
    step += letter.node.offsetWidth;
    const target = index === typing.length - 1 ? end : Math.max(step, index === 0 ? Math.min(start, end) : 0);
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      letter.waiting = false;
      width.to(target);
      fadeIn(element, state, letter, letter.shown, type.duration, false);
    }, (type.lead + index * type.stagger) * slow);
    state.timers.add(timer);
  });
}

function fadeIn(element: HTMLElement, state: Morph, letter: Letter, from: number, duration: number, reducedMotion: boolean): void {
  letter.fade?.stop();
  letter.fade = tween(from, 1, { duration, ease: easeOut }, value => paint(letter, value, reducedMotion), () => {
    letter.fade = undefined;
    paint(letter, 1, reducedMotion);
    finishIfIdle(element, state);
  });
}

function leaveLetters(state: Morph, letters: Letter[], reducedMotion: boolean): void {
  const element = state.frame.element;
  // Read every position before the first letter leaves the flow.
  const placed = letters.map(letter => ({ letter, left: letter.node.offsetLeft, top: letter.node.offsetTop }));
  let order = 0;
  for (const { letter, left, top } of placed) {
    letter.fade?.stop();
    letter.fade = undefined;
    if (letter.waiting || letter.shown <= 0) {
      letter.node.remove();
      continue;
    }
    letter.node.style.position = "absolute";
    letter.node.style.left = `${left}px`;
    letter.node.style.top = `${top}px`;
    state.leaving.add(letter);
    letter.fade = tween(letter.shown, 0, {
      duration: reducedMotion ? crossfade : leave.duration,
      delay: reducedMotion ? 0 : order++ * leave.stagger,
      ease: reducedMotion ? easeOut : easeIn,
    }, value => paint(letter, value, reducedMotion), () => {
      letter.fade = undefined;
      letter.node.remove();
      state.leaving.delete(letter);
      finishIfIdle(element, state);
    });
  }
}
