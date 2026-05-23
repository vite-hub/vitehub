import { defineEval, textContains } from "../../src/eval.ts"

await Promise.resolve()

export default defineEval({
  scenarios: [{
    input: { prompt: "hello" },
    name: "hello",
    scorers: [textContains("async eval config")],
  }],
})
