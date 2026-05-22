import { defineEval, textContains } from "../../../src/eval.ts"

function defineParenEval() {
  return defineEval({
    scenarios: [{
      input: { prompt: "hello" },
      name: "hello",
      scorers: [textContains("paren config")],
    }],
  })
}

export default defineParenEval()
