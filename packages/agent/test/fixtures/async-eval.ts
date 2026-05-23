export default {
  generate: async () => ({ text: "async eval config" }),
  stream: async () => {
    throw new Error("stream is not used by this eval fixture.")
  },
  tools: {},
  version: "agent-v1",
}
