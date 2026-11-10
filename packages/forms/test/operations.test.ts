import { expect, it } from "vitest"

import { formsOperations } from "../src/operations.ts"

import type { FormSubmission } from "../src/types.ts"

it("prints submission previews without terminal controls and preserves stored data", () => {
  const message = "\u001B[2JHello \u001B]0;Untrusted title\u0007world\u001B[31m!\u001B[0m\b\r\nNext line"
  const row: FormSubmission = {
    id: "submission", form: "contact", status: "open", createdAt: 0, updatedAt: 0,
    page: null, anchor: null, user: null, data: { message },
  }
  const list = formsOperations.find(operation => operation.name === "forms.list")!
  const output = list.cli!.format!([row] as never)
  expect(output).toContain("Hello world! Next line")
  for (const control of ["\u001B", "\u0007", "\b", "\r"]) expect(output).not.toContain(control)
  expect(row.data).toEqual({ message })
})
