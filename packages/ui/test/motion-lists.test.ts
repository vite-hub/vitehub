// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ring, ringing } from "../src/motion/helpers/ring.ts";
import { createHoldToDelete, type HoldToDeleteOptions } from "../src/motion/hold-to-delete.ts";
import { createMotionList } from "../src/motion/list.ts";
import { forceReducedMotion } from "../src/motion/reduced-motion.ts";

// A frame clock that the test advances by hand, 60 frames per second.
let queue: FrameRequestCallback[] = [];
let now = 0;

function tick(frames = 1): void {
  for (let index = 0; index < frames; index++) {
    const callbacks = queue;
    queue = [];
    now += 1000 / 60;
    for (const callback of callbacks) callback(now);
  }
}

function framesUntilIdle(limit = 2000): number {
  let frames = 0;
  while (queue.length && frames < limit) {
    tick();
    frames++;
  }
  return frames;
}

/** Gives `element` a layout box. The box moves with the `translate` that the list writes, as a browser's does. */
function place(element: HTMLElement, box: { x: number; y: number; width?: number; height?: number }): void {
  element.getBoundingClientRect = () => {
    const [dx = 0, dy = 0] = (element.style.translate || "0px 0px").split(" ").map(part => Number.parseFloat(part));
    const width = box.width ?? 200;
    const height = box.height ?? 40;
    return DOMRect.fromRect({ x: box.x + dx, y: box.y + dy, width, height });
  };
}

function translateOf(element: HTMLElement): [number, number] {
  const [x = 0, y = 0] = (element.style.translate || "0px 0px").split(" ").map(part => Number.parseFloat(part));
  return [x, y];
}

beforeEach(() => {
  queue = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queue.push(callback));
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  document.body.innerHTML = "";
});

afterEach(() => {
  framesUntilIdle();
  forceReducedMotion(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function list(count: number): { container: HTMLElement; items: HTMLElement[] } {
  const container = document.createElement("ul");
  const items = Array.from({ length: count }, (_, index) => {
    const item = document.createElement("li");
    item.textContent = `Item ${index}`;
    place(item, { x: 0, y: index * 40 });
    container.append(item);
    return item;
  });
  document.body.append(container);
  return { container, items };
}

it("cleans up a running ring when reduced motion turns on", () => {
  const button = document.createElement("button");
  button.style.boxShadow = "0 0 1px black";
  document.body.append(button);
  const shadow = button.style.boxShadow;
  ring(button);
  tick(3);
  expect(ringing(button)).toBe(true);
  forceReducedMotion(true);
  tick();
  expect(ringing(button)).toBe(false);
  expect(button.style.boxShadow).toBe(shadow);
});

describe("createMotionList", () => {
  it("starts a moved item where it was, then springs it to its new place and clears what it wrote", () => {
    const { container, items } = list(3);
    const motion = createMotionList(container);
    motion.measure();
    // A new first item pushes each item down by 40px.
    place(items[0]!, { x: 0, y: 40 });
    place(items[1]!, { x: 0, y: 80 });
    place(items[2]!, { x: 0, y: 120 });
    motion.play();
    expect(translateOf(items[0]!)).toEqual([0, -40]);
    expect(translateOf(items[2]!)).toEqual([0, -40]);
    tick(4);
    const [, partway] = translateOf(items[0]!);
    expect(partway).toBeGreaterThan(-40);
    expect(partway).toBeLessThan(0);
    framesUntilIdle();
    expect(items[0]!.style.translate).toBe("");
  });

  it("continues from where an item is when a second change comes before it settles", () => {
    const { container, items } = list(2);
    const motion = createMotionList(container);
    motion.measure();
    place(items[1]!, { x: 0, y: 80 });
    motion.play();
    tick(5);
    const [, before] = translateOf(items[1]!);
    // The item is seen at 80 + before. It moves back to 40 before it settles.
    motion.measure();
    place(items[1]!, { x: 0, y: 40 });
    motion.play();
    const [, after] = translateOf(items[1]!);
    expect(80 + before).toBeCloseTo(40 + after, 1);
    framesUntilIdle();
    expect(items[1]!.style.translate).toBe("");
  });

  it("grows a new item in its slot, and from its origin when it has one", () => {
    const { container, items } = list(1);
    const motion = createMotionList(container);
    motion.measure();
    const added = document.createElement("li");
    place(added, { x: 0, y: 40 });
    container.append(added);
    motion.play();
    expect(added.style.opacity).toBe("0.000");
    expect(added.style.scale).toBe("0.9000");
    expect(added.style.translate).toBe("");
    framesUntilIdle();
    expect(added.style.opacity).toBe("");
    expect(added.style.scale).toBe("");

    motion.measure();
    const copy = document.createElement("li");
    place(copy, { x: 0, y: 80 });
    container.append(copy);
    motion.play({ origin: () => items[0] });
    // It starts on the item it copies: 80px higher.
    expect(translateOf(copy)).toEqual([0, -80]);
    tick(6);
    const [, moving] = translateOf(copy);
    expect(moving).toBeGreaterThan(-80);
    framesUntilIdle();
    expect(copy.style.translate).toBe("");
  });

  it("folds a removed item away as a copy, and removes the copy when it is gone", () => {
    const { container, items } = list(3);
    const motion = createMotionList(container);
    motion.measure();
    items[1]!.remove();
    place(items[2]!, { x: 0, y: 40 });
    motion.play();
    const ghost = container.querySelector<HTMLElement>("[data-motion-ghost]");
    expect(ghost?.textContent).toBe("Item 1");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.style.top).toBe("40px");
    expect(translateOf(items[2]!)).toEqual([0, 40]);
    framesUntilIdle();
    expect(container.querySelector("[data-motion-ghost]")).toBeNull();
    expect(items[2]!.style.translate).toBe("");
  });

  it("keeps an entering duplicate in place across another layout change", () => {
    const { container, items } = list(2);
    const motion = createMotionList(container);
    const copy = document.createElement("li");
    motion.measure();
    place(copy, { x: 0, y: 80 });
    container.append(copy);
    motion.play({ origin: items[0] });
    tick(4);

    const before = copy.getBoundingClientRect().top;
    motion.measure();
    place(copy, { x: 0, y: 120 });
    motion.play();
    expect(copy.getBoundingClientRect().top).toBeCloseTo(before, 1);
    motion.destroy();
  });

  it("settles a targeted exit when reduced motion turns on", async () => {
    const { container, items } = list(2);
    const motion = createMotionList(container);
    motion.measure();
    items[0]!.remove();
    motion.play({ target: items[1] });
    tick(3);
    expect(container.querySelector("[data-motion-ghost]")).not.toBeNull();
    forceReducedMotion(true);
    tick();
    await Promise.resolve();
    expect(container.querySelector("[data-motion-ghost]")).toBeNull();
    motion.destroy();
  });

  it("does not submit inputs from a removed row's copy", () => {
    const { container, items } = list(1);
    const form = document.createElement("form");
    document.body.append(form);
    form.append(container);
    items[0]!.innerHTML = '<input name="authors" value="Ada">';
    const motion = createMotionList(container);
    motion.measure();
    items[0]!.remove();
    motion.play();
    expect(container.querySelector("[data-motion-ghost]")).not.toBeNull();
    expect(new FormData(form).has("authors")).toBe(false);
    motion.destroy();
  });

  it("does not move items that are off screen before and after the change", () => {
    const { container, items } = list(2);
    place(items[0]!, { x: 0, y: 2000 });
    place(items[1]!, { x: 0, y: 2040 });
    const motion = createMotionList(container);
    motion.measure();
    place(items[0]!, { x: 0, y: 2040 });
    place(items[1]!, { x: 0, y: 2080 });
    motion.play();
    expect(items[0]!.style.translate).toBe("");
    expect(queue).toHaveLength(0);
  });

  it("moves nothing inside data-motion=none, and only cross-fades under reduced motion", () => {
    const { container, items } = list(2);
    container.dataset.motion = "none";
    const motion = createMotionList(container);
    motion.measure();
    place(items[1]!, { x: 0, y: 80 });
    items[0]!.remove();
    motion.play();
    expect(items[1]!.style.translate).toBe("");
    expect(container.querySelector("[data-motion-ghost]")).toBeNull();

    delete container.dataset.motion;
    forceReducedMotion(true);
    motion.measure();
    place(items[1]!, { x: 0, y: 40 });
    const added = document.createElement("li");
    place(added, { x: 0, y: 80 });
    container.append(added);
    motion.play();
    expect(items[1]!.style.translate).toBe("");
    expect(added.style.scale).toBe("");
    expect(added.style.opacity).toBe("0.000");
    tick(4);
    expect(Number(added.style.opacity)).toBeGreaterThan(0);
    framesUntilIdle();
    expect(added.style.opacity).toBe("");
  });
});

describe("createHoldToDelete", () => {
  function setup(options: Partial<HoldToDeleteOptions> = {}) {
    const button = document.createElement("button");
    document.body.append(button);
    const events: string[] = [];
    const commit = vi.fn(async () => {
      events.push("commit");
    });
    const hold = createHoldToDelete(button, {
      commit,
      onDelete: () => events.push("delete"),
      onUndo: () => events.push("undo"),
      undoFor: 5000,
      ...options,
    });
    const press = () => button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    const release = () => button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
    return { button, commit, events, hold, press, release };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    forceReducedMotion(true);
  });

  it("cancels a keyboard hold on blur", () => {
    const { button, events, hold } = setup();
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    tick(10);
    button.blur();
    tick(80);
    expect(events).toEqual([]);
    expect(hold.state).toBe("idle");
    hold.destroy();
  });

  it("ignores confirmation that resolves after destroy", async () => {
    const confirmation = Promise.withResolvers<boolean>();
    const { button, events, hold } = setup({ confirm: () => confirmation.promise });
    button.click();
    hold.destroy();
    confirmation.resolve(true);
    await confirmation.promise;
    expect(events).toEqual([]);
  });

  it("keeps the exit copy out of its form and offers Undo if reduced motion turns on", async () => {
    forceReducedMotion(false);
    const form = document.createElement("form");
    form.id = "authors-form";
    const input = document.createElement("input");
    input.setAttribute("form", form.id);
    input.name = "authors";
    input.value = "Ada";
    document.body.append(form, input);
    const { button, hold, press } = setup({ item: () => input, onDelete: () => input.remove() });
    press();
    tick(75);
    expect(hold.state).toBe("leaving");
    expect(document.querySelector("input[aria-hidden=true]")).not.toBeNull();
    expect(new FormData(form).has("authors")).toBe(false);
    forceReducedMotion(true);
    await Promise.resolve();
    expect(document.querySelector("input[aria-hidden=true]")).toBeNull();
    expect(hold.state).toBe("undo");
    expect(button.textContent).toBe("Undo");
    hold.destroy();
  });

  it("commits once, after the Undo window", async () => {
    const { button, commit, events, hold, press } = setup();
    press();
    tick(Math.ceil(1.1 * 60) + 2);
    expect(events).toEqual(["delete"]);
    expect(hold.state).toBe("undo");
    expect(button.textContent).toBe("Undo");
    await vi.advanceTimersByTimeAsync(4900);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(hold.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("cancels a hold that is let go early", async () => {
    const { commit, events, hold, press, release } = setup();
    press();
    tick(30);
    release();
    framesUntilIdle();
    expect(hold.state).toBe("idle");
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not commit after Undo", async () => {
    const { button, commit, events, hold, press, release } = setup();
    press();
    framesUntilIdle();
    // The click that ends the hold does not undo it.
    release();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hold.state).toBe("undo");
    button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    release();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(hold.state).toBe("idle");
    expect(button.textContent).toBe("Hold to delete");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual(["delete", "undo"]);
  });

  it("commits at once when it is destroyed during the Undo window, and cancels a hold that is not complete", async () => {
    const first = setup();
    first.press();
    framesUntilIdle();
    first.hold.destroy();
    expect(first.commit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.commit).toHaveBeenCalledTimes(1);

    const second = setup();
    second.press();
    tick(20);
    second.hold.destroy();
    framesUntilIdle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(second.commit).not.toHaveBeenCalled();
    expect(second.events).toEqual([]);
  });

  it("brings the item back when the commit fails", async () => {
    const onError = vi.fn();
    const { events, hold, press } = setup({ commit: () => Promise.reject(new Error("offline")), onError });
    press();
    framesUntilIdle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toEqual(["delete", "undo"]);
    expect(onError).toHaveBeenCalledWith(new Error("offline"));
    expect(hold.state).toBe("idle");
  });

  it("holds with Space, and deletes after a confirm from a click that is not a hold", async () => {
    const confirm = vi.fn(() => true);
    const { button, events, hold } = setup({ confirm });
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    tick(20);
    expect(hold.state).toBe("holding");
    button.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    framesUntilIdle();
    expect(hold.state).toBe("idle");
    expect(confirm).not.toHaveBeenCalled();

    // A screen reader activates the button with a click and no pointer or key press.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["delete"]);
    expect(hold.state).toBe("undo");
  });

  it("plays the full hold with motion, then shows Undo", async () => {
    forceReducedMotion(false);
    const { button, hold, press } = setup({ label: "Delete" });
    press();
    tick(Math.ceil(1.1 * 60) + 2);
    expect(hold.state).toBe("leaving");
    for (let index = 0; index < 120 && hold.state === "leaving"; index++) {
      tick(1);
      await vi.advanceTimersByTimeAsync(17);
    }
    expect(hold.state).toBe("undo");
    expect(button.querySelector("[data-part=text]")?.textContent).toBe("Undo");
  });
});
