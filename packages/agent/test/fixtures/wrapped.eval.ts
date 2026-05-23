import { defineEval, textContains } from "../../src/eval.ts"

function defineWrappedEval() {
  return defineEval({
    scenarios: [{
      input: { prompt: "hello" },
      name: "hello",
      scorers: [textContains("wrapped config")],
    }],
  })
}

export default defineWrappedEval()
