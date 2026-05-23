import { defineEval, textContains } from "../../../src/eval.ts"

export default defineEval({
  scenarios: [{
    input: { prompt: "hello" },
    name: "hello",
    scorers: [textContains("folder config")],
  }],
})
