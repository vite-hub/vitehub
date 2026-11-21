// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineMotionEffect, installMotion } from "../src/motion.ts";

let stop: () => void;
let frames: FrameRequestCallback[];
let frameTime: number;

function frame(): void {
  const pending = frames.splice(0);
  frameTime += 1000 / 60;
  for (const callback of pending) callback(frameTime);
}

beforeEach(() => {
  frames = [];
  frameTime = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
  stop();
  for (let count = 0; count < 200 && frames.length; count++) frame();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mutations = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function startMotion(root?: HTMLElement): void {
  stop = installMotion(root);
  defineMotionEffect({ name: "slider", selector: "[role=slider]" });
}

function mountPanel(): HTMLElement {
  const panel = document.createElement("nav");
  panel.setAttribute("data-motion-panel", "");
  panel.style.boxSizing = "border-box";
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(() =>
    new DOMRect(0, 0, Number.parseFloat(panel.style.width) || (panel.hasAttribute("data-open") ? 232 : 52), 0));
  document.body.append(panel);
  return panel;
}

it("does not rewrite panel state to measure its width", async () => {
  const panel = mountPanel();
  startMotion();
  const set = vi.spyOn(panel, "setAttribute");
  const remove = vi.spyOn(panel, "removeAttribute");
  panel.setAttribute("data-open", "");
  await mutations();
  expect(panel.style.width).toBe("52px");
  expect(set.mock.calls.filter(([name]) => name === "data-open")).toEqual([["data-open", ""]]);
  expect(remove).not.toHaveBeenCalledWith("data-open");
});

it("cancels a panel spring when the new width is already reached", async () => {
  const panel = mountPanel();
  startMotion();
  panel.setAttribute("data-open", "true");
  await mutations();
  expect(panel.style.width).toBe("52px");
  panel.removeAttribute("data-open");
  await mutations();
  frame();
  frame();
  expect(panel.style.width).toBe("");
});

it("tracks a panel that is itself the installed element", async () => {
  const panel = mountPanel();
  startMotion(panel);
  panel.setAttribute("data-open", "");
  await mutations();
  expect(panel.style.width).toBe("52px");
});

it("keeps a panel tracked when an overlapping install stops", async () => {
  const panel = mountPanel();
  startMotion();
  const stopPanel = installMotion(panel);
  stopPanel();
  panel.setAttribute("data-open", "");
  await mutations();
  expect(panel.style.width).toBe("52px");
});

it("dispatches added nodes once across overlapping roots", async () => {
  const parent = document.body.appendChild(document.createElement("section"));
  const child = document.createElement("p");
  const enter = vi.fn();
  const content = vi.fn();
  startMotion();
  const stopParent = installMotion(parent);
  const stopEnter = defineMotionEffect({ name: "test-enter", selector: "section > p", enter });
  const stopContent = defineMotionEffect({ name: "test-content", selector: "section", content });
  try {
    parent.appendChild(child);
    await mutations();
    expect(enter.mock.calls).toEqual([[child]]);
    expect(content.mock.calls).toEqual([[parent, { added: [child], removed: [], oldText: undefined }]]);
  }
  finally {
    stopEnter();
    stopContent();
    stopParent();
  }
});

it("stops turning a chevron when code closes its disclosure", async () => {
  document.body.innerHTML = `
    <style>[aria-expanded=true] svg { rotate: 90deg; }</style>
    <button aria-expanded="false"><svg data-motion-chevron></svg></button>
  `;
  const button = document.querySelector("button")!;
  const icon = document.querySelector("svg")!;
  startMotion();
  const stopButton = installMotion(button);
  try {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    button.setAttribute("aria-expanded", "true");
    await mutations();
    expect(icon.style.rotate).not.toBe("");
    button.setAttribute("aria-expanded", "false");
    await mutations();
    frame();
    expect(icon.style.rotate).toBe("");
  }
  finally {
    stopButton();
  }
});
