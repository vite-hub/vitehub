import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan, Scene, TokenState } from "../app/utils/hero-figure/engine";
import { timeline } from "../app/utils/hero-figure/engine";
import { HERO_ICONS } from "../app/utils/hero-figure/icons";
import { heroFigures } from "../app/utils/hero-figure";

const dir = resolve(import.meta.dirname, "../app/utils/hero-figure/scenes");
const docsRoot = resolve(import.meta.dirname, "../content/docs");
const keys = readdirSync(dir).filter(file => file.endsWith(".ts")).map(file => file.slice(0, -3)).sort();

async function load(key: string): Promise<Scene<Plan>> {
  const mod: { default: Scene<Plan> } = await import(`../app/utils/hero-figure/scenes/${key}.ts`);
  return mod.default;
}

const stepsOf = (scene: Scene<Plan>, plan: Plan) => typeof scene.steps === "function" ? scene.steps(plan) : scene.steps;
const LOOPS = 20;

describe("hero figures", () => {
  it("has one scene for each primitive landing page that shows a figure", () => {
    expect(Object.keys(heroFigures).sort()).toEqual(keys);
    const pages = readdirSync(docsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    const named = pages.flatMap((page) => {
      try {
        return [...readFileSync(resolve(docsRoot, page, "index.md"), "utf8").matchAll(/:hero-figure\{name="([^"]+)"\}/g)].map(match => [page, match[1]]);
      }
      catch {
        return [];
      }
    });
    expect(named.map(([page]) => page).sort()).toEqual(keys);
    for (const [page, name] of named) expect(name).toBe(page);
  });

  it.each(keys)("%s: names only icons from the generated set", (key) => {
    const source = readFileSync(resolve(dir, `${key}.ts`), "utf8");
    for (const [, name] of source.matchAll(/["'`]((?:simple-icons|lucide):[a-z0-9-]+)["'`]/g)) expect(HERO_ICONS, name).toHaveProperty([name!]);
  });

  it.each(keys)("%s: scopes its CSS to its own figure", async (key) => {
    const scene = await load(key);
    expect(scene.key).toBe(key);
    const css = scene.css ?? "";
    for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
      const selectors = rule[2]!.split(",").map(selector => selector.trim()).filter(selector => !/^(from|to|\d+%)$/.test(selector));
      for (const selector of selectors) expect(selector, `${key}: ${selector}`).toMatch(new RegExp(`^\\.vh-fig\\.vh-hero-${key}|^\\.vh-hero-${key}\\b`));
    }
  });

  // The loop is the same for every reader and every test run, and each loop changes something real.
  it.each(keys)("%s: plans the same loop for the same k, and loops of a sensible length", async (key) => {
    const scene = await load(key);
    const plans = Array.from({ length: LOOPS }, (_, k) => scene.plan(k));
    expect(JSON.stringify(scene.plan(3), (_, value) => typeof value === "function" ? String(value) : value)).toBe(JSON.stringify(plans[3], (_, value) => typeof value === "function" ? String(value) : value));
    for (const plan of plans) {
      expect(plan.len).toBeGreaterThanOrEqual(8000);
      expect(plan.len).toBeLessThanOrEqual(20000);
      // Readers who turn motion off see the frame at `end`: it must be inside the loop, before the fade.
      expect(plan.end ?? plan.len - 600).toBeLessThanOrEqual(plan.len - 500);
    }
  });

  it.each(keys)("%s: writes plain captions", async (key) => {
    const scene = await load(key);
    const sentences = [scene.summary, scene.label, ...Array.from({ length: LOOPS }, (_, k) => stepsOf(scene, scene.plan(k))).flat()];
    for (const sentence of sentences) {
      expect(sentence.trim().length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/[—]|NaN|undefined/);
    }
    expect(stepsOf(scene, scene.plan(0)).length).toBeGreaterThanOrEqual(3);
    expect(stepsOf(scene, scene.plan(0)).length).toBeLessThanOrEqual(6);
  });

  // Lane scenes describe their tokens in a timeline. Two tokens on the same row must never share a place.
  it.each(keys)("%s: never puts two balls on the same spot", async (key) => {
    const scene = await load(key);
    if (scene.render || !scene.tokens?.length) return;
    const width = 640;
    for (let k = 0; k < LOOPS; k++) {
      const plan = scene.plan(k);
      for (let t = 0; t < plan.len; t += 40) {
        const frame = scene.frame ? scene.frame(t, plan) : "T" in plan ? timeline(t, plan as Plan & Parameters<typeof timeline>[1]) : {};
        const shown = Object.entries(frame.tok ?? {}).filter((entry): entry is [string, TokenState] => !entry[1].hidden && (entry[1].a ?? 1) > 0.2);
        for (let i = 0; i < shown.length; i++) {
          for (let j = i + 1; j < shown.length; j++) {
            const [a, b] = [shown[i]![1], shown[j]![1]];
            const dx = Math.abs((a.p[0] - b.p[0]) * width / 100 + (a.dx ?? 0) - (b.dx ?? 0));
            const dy = Math.abs(a.p[1] - b.p[1]);
            expect(dx > 10 || dy > 10, `${key} loop ${k} at ${t} ms: ${shown[i]![0]} and ${shown[j]![0]}`).toBe(true);
          }
        }
      }
    }
  });
});
