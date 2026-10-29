import { describe, expect, it } from "vitest"

import { mergeContentDocument } from "../src/merge.ts"

const base = `---
title: Wedding weekend
date: 2026-12-12
---

::event{time="09:30"}
Ceremony at the temple
#description
Monks bless the couple. Guests sit on the left side.
::

::event{time="18:00"}
Dinner by the river
::
`

describe("mergeContentDocument", () => {
  it("merges edits to different events", () => {
    const ours = base.replace("Dinner by the river", "Dinner and dancing by the river")
    const theirs = base.replace("Ceremony at the temple", "Ceremony at Wat Phra That")
    expect(mergeContentDocument(base, ours, theirs, "markdown")).toEqual({
      text: base.replace("Dinner by the river", "Dinner and dancing by the river").replace("Ceremony at the temple", "Ceremony at Wat Phra That"),
    })
  })

  it("merges a title and a body on neighbouring lines, which a line merge cannot", () => {
    const ours = base.replace("Ceremony at the temple", "Morning ceremony")
    const theirs = base.replace("Monks bless the couple.", "Nine monks bless the couple.")
    expect(mergeContentDocument(base, ours, theirs, "markdown")).toEqual({
      text: base.replace("Ceremony at the temple", "Morning ceremony").replace("Monks bless the couple.", "Nine monks bless the couple."),
    })
  })

  it("merges different sentences of one paragraph", () => {
    const ours = base.replace("Monks bless the couple.", "Monks bless the couple with water.")
    const theirs = base.replace("Guests sit on the left side.", "Guests of the groom sit on the left side.")
    expect(mergeContentDocument(base, ours, theirs, "markdown")).toEqual({
      text: base.replace("Monks bless the couple.", "Monks bless the couple with water.").replace("Guests sit on the left side.", "Guests of the groom sit on the left side."),
    })
  })

  it("conflicts when both change the same words", () => {
    expect(mergeContentDocument(base, base.replace("09:30", "10:00"), base.replace("09:30", "09:45"), "markdown")).toEqual({ conflicts: [{ body: true }] })
  })

  it("conflicts when one side deletes text that the other edits", () => {
    const ours = base.replace("#description\nMonks bless the couple. Guests sit on the left side.\n", "")
    const theirs = base.replace("Guests sit on the left side.", "Guests sit on the right side.")
    expect(mergeContentDocument(base, ours, theirs, "markdown")).toEqual({ conflicts: [{ body: true }] })
  })

  it.each([false, true])("conflicts on a deletion against a replacement split around repeated whitespace (reversed: %s)", (reversed) => {
    const ours = reversed ? " y b a" : " b a"
    const theirs = reversed ? " b a" : " y b a"
    expect(mergeContentDocument("a b a", ours, theirs, "markdown")).toEqual({ conflicts: [{ body: true }] })
  })

  it("takes the same change made on both sides once", () => {
    const both = base.replace("18:00", "19:00")
    expect(mergeContentDocument(base, both, both, "markdown")).toEqual({ text: both })
  })

  it("takes a shared word replacement alongside independent replacements", () => {
    expect(mergeContentDocument("a b c", "x y c", "x b z", "markdown")).toEqual({ text: "x y z" })
  })

  it("merges fields one by one and names a field that both changed", () => {
    const ours = base.replace("title: Wedding weekend", "title: Our wedding weekend")
    const theirs = base.replace("date: 2026-12-12", "date: 2026-12-13")
    expect(mergeContentDocument(base, ours, theirs, "markdown")).toEqual({
      text: "---\ntitle: Our wedding weekend\ndate: 2026-12-13\n---\n" + base.slice(base.indexOf("\n::event") ),
    })
    expect(mergeContentDocument(base, ours, base.replace("title: Wedding weekend", "title: The weekend"), "markdown")).toEqual({ conflicts: [{ field: "title" }] })
  })

  it("keeps the frontmatter bytes of a side when its fields win", () => {
    const written = base.replace("title: Wedding weekend", "title: 'Wedding weekend' # set by Maxi")
    const theirs = written.replace("Dinner by the river", "Dinner on the river")
    const ours = written.replace("Monks bless", "Nine monks bless")
    expect(mergeContentDocument(written, ours, theirs, "markdown")).toEqual({
      text: written.replace("Dinner by the river", "Dinner on the river").replace("Monks bless", "Nine monks bless"),
    })
  })

  it("merges data files by field", () => {
    const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`
    expect(mergeContentDocument(json({ a: 1, b: 1 }), json({ a: 2, b: 1 }), json({ a: 1, b: 2 }), "json")).toEqual({ text: json({ a: 2, b: 2 }) })
    expect(mergeContentDocument(json({ a: 1 }), json({ a: 2 }), json({ a: 3 }), "json")).toEqual({ conflicts: [{ field: "a" }] })
  })

  it.each(["json", "yaml"] as const)("preserves an own __proto__ field in a %s merge", (format) => {
    const document = (value: number, other: number) => format === "json"
      ? `${JSON.stringify({ ["__proto__"]: value, other }, null, 2)}\n`
      : `__proto__: ${value}\nother: ${other}\n`
    expect(mergeContentDocument(document(1, 1), document(2, 1), document(1, 2), format)).toEqual({ text: document(2, 2) })
  })

  it("conflicts on a file that does not parse", () => {
    expect(mergeContentDocument("---\na: [\n---\n", "---\na: 1\n---\n", "---\na: 2\n---\n", "markdown")).toEqual({ conflicts: [{ body: true }] })
  })
})
