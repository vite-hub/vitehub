import { expect, it } from "vitest"

import { validateMessagePlaceholders } from "../src/record-format.ts"

it("reports rich-text tag problems as brace issues", () => {
  expect(validateMessagePlaceholders("Read <0>the docs</0>", "Lee </0>")).toEqual([{ code: "brace", message: "Invalid message: Unpaired rich-text tag </0>" }])
  expect(validateMessagePlaceholders("Read <0>the docs</0>", "Lee <0>los docs")).toEqual([{ code: "brace", message: "Invalid message: Unclosed rich-text tag" }])
  expect(validateMessagePlaceholders("{count, plural, one {<0>one</0>} other {<0>many</0>}}", "{count, plural, one {<0>uno} other {<0>muchos</0>}}")).toEqual([{ code: "brace", message: "Invalid message: Unbalanced rich-text tags across ICU choices" }])
  expect(validateMessagePlaceholders("Read <0>the docs</0>", "Lee <0>los docs</0>")).toEqual([])
})
