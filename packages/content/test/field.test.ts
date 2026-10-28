import { describe, expect, it } from "vitest"

import { contentField, formatContentField, parseContentField } from "../src/client.ts"

describe("contentField", () => {
  it("writes the field address of a singleton or a document", () => {
    expect(contentField("about", "hero.title")).toEqual({ "data-content-field": "about#hero.title" })
    expect(contentField("posts", "2026/hello", "title")).toEqual({ "data-content-field": "posts:2026/hello#title" })
  })

  it("reads back what it wrote, and nothing else", () => {
    expect(parseContentField("about#hero.title")).toEqual({ collection: "about", field: "hero.title" })
    expect(parseContentField("posts:2026/hello#cards.0.title")).toEqual({ collection: "posts", id: "2026/hello", field: "cards.0.title" })
    for (const value of ["", "about", "#title", "about#", "posts:#title", "about#hero..title", "1x#title"]) {
      expect(parseContentField(value)).toBeUndefined()
    }
  })

  it("throws for names and paths the address cannot hold", () => {
    expect(() => formatContentField({ collection: "about", field: "hero title" })).toThrow(/field path/)
    expect(() => formatContentField({ collection: "posts", id: "a#b", field: "title" })).toThrow(/document id/)
  })
})
