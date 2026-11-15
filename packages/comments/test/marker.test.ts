// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"

import { labelBox, labelInk, markerBox, markerColors, shareStyles, strokePath } from "../src/overlay/marker.ts"

describe("the Marker's ink", () => {
  it("keeps a stroke from before tips a marker", () => {
    expect(markerBox([{ color: "#ec4899", points: [[100, 100], [200, 100]] }])).toEqual({ left: 93, top: 93, width: 114, height: 14 })
  })

  it("boxes an arrow with its bow and head, and a pen with half its width", () => {
    const arrow = markerBox([{ tip: "arrow", color: "#2563eb", points: [[100, 100], [200, 100]] }])!
    // The head's strokes reach out of the shaft's line, and the bow reaches 8px under it.
    expect(arrow.left).toBe(98.5)
    expect(arrow.left + arrow.width).toBe(201.5)
    expect(arrow.top).toBeCloseTo(92.81, 1)
    expect(arrow.top + arrow.height).toBeCloseTo(111.92, 1)
    expect(markerBox([{ tip: "pen", color: "#2563eb", points: [[100, 100], [200, 100]] }])).toEqual({ left: 98.5, top: 98.5, width: 103, height: 3 })
  })

  it("bows an arrow unless it is straight", () => {
    const bowed = strokePath({ tip: "arrow", color: "#2563eb", points: [[0, 0], [100, 0]] })
    // Drop's arrowPath gives the same path for these points.
    expect(bowed).toBe("M0.0 0.0Q50.0 8.0 100.0 0.0M86.6 10.4L100.0 0.0L84.0 -5.7")
    expect(strokePath({ tip: "arrow", color: "#2563eb", points: [[0, 0], [100, 0]], straight: true })).toMatch(/^M0\.0 0\.0Q50\.0 0\.0 100\.0 0\.0M/)
  })

  it("boxes a label from its left middle point, with room for its shadow", () => {
    const label = { tip: "text" as const, color: "#2563eb", points: [[100, 100]] as Array<[number, number]>, text: "Hi" }
    const box = labelBox(label)
    expect(box).toMatchObject({ left: 100, top: 85, height: 30, padding: 9, radius: 7 })
    expect(markerBox([label])).toEqual({ left: 100, top: 85, width: box.width, height: 32 })
  })

  it("writes a label's words in the color that reads on its ink", () => {
    expect(Object.fromEntries(Object.entries(markerColors).map(([name, hex]) => [name, labelInk(hex)]))).toEqual({
      pink: "#ffffff",
      amber: "#0a0a0a",
      blue: "#ffffff",
      green: "#ffffff",
    })
  })
})

describe("the screenshot's SVG", () => {
  it("turns each distinct inline style into one shared class", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    const object = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject")
    svg.append(object)
    const rows = Array.from({ length: 3 }, () => {
      const row = document.createElement("div")
      row.setAttribute("style", "color: red; margin-top: 4px;")
      object.append(row)
      return row
    })
    const other = document.createElement("span")
    other.setAttribute("style", "color: blue;")
    object.append(other)

    shareStyles(svg)
    expect(svg.querySelectorAll("[style]")).toHaveLength(0)
    expect(new Set(rows.map(row => row.className))).toEqual(new Set(["_s0"]))
    expect(other.className).toBe("_s1")
    expect(svg.firstElementChild?.localName).toBe("style")
    expect(svg.firstElementChild?.textContent).toBe("._s0{color:red!important;margin-top:4px!important;}\n._s1{color:blue!important;}\n")
  })
})
