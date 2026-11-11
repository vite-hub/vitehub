import { describe, expect, it } from "vitest"

import { buildIconSet, readIconBodies } from "../scripts/build.ts"

const bodies = readIconBodies()
const numbers = (body: string) => [...body.matchAll(/\b(?:x|y|cx|cy|width|height)="([\d.]+)"/g)].map(match => Number(match[1]))

describe("@vite-hub/icons", () => {
  it("draws every icon from paths, rects, and circles, with at most one moving group", () => {
    for (const [name, body] of Object.entries(bodies)) {
      const tags = [...body.matchAll(/<([a-z]+)\b/g)].map(match => match[1])
      expect(tags.filter(tag => !["g", "path", "rect", "circle"].includes(tag)), name).toEqual([])
      expect(body.match(/<g data-motion="">/g)?.length ?? 0, name).toBeLessThanOrEqual(1)
      expect(body, name).not.toMatch(/stroke-width="(?!1\.5")|fill="(?!none")|style=|transform=/)
    }
  })

  it("keeps shapes on the half-pixel grid inside the 24px frame", () => {
    for (const [name, body] of Object.entries(bodies)) {
      for (const value of numbers(body)) {
        expect(value * 2 % 1, `${name}: ${value}`).toBe(0)
        expect(value, name).toBeLessThanOrEqual(24)
      }
    }
  })

  it("keeps rects and circles inside the 3px margin", () => {
    for (const [name, body] of Object.entries(bodies)) {
      for (const [, x, y, width, height] of body.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
        expect([Number(x), Number(y)].every(edge => edge >= 3), name).toBe(true)
        expect([Number(x) + Number(width), Number(y) + Number(height)].every(edge => edge <= 21), name).toBe(true)
      }
      for (const [, cx, cy, r] of body.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
        expect(Math.min(Number(cx), Number(cy)) - Number(r), name).toBeGreaterThanOrEqual(3)
        expect(Math.max(Number(cx), Number(cy)) + Number(r), name).toBeLessThanOrEqual(21)
      }
    }
  })

  it("names icons in kebab case", () => {
    // Digits are allowed, so `i18n` keeps its `vite-hub/i18n` import name.
    for (const name of Object.keys(bodies)) expect(name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  })

  it("publishes the built set as Iconify JSON", async () => {
    const set = buildIconSet(bodies)
    expect((await import("../dist/index.js")).icons).toEqual(set)
    expect(set.prefix).toBe("vitehub")
    expect(set.info.total).toBe(Object.keys(bodies).length)
  })
})
