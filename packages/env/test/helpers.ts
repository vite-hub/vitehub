export function stringSchema() {
  return {
    safeParse(input: unknown) {
      return typeof input === "string" && input.length > 0
        ? { data: input, success: true as const }
        : { error: new Error("Expected non-empty string"), success: false as const }
    },
  }
}

export function booleanSchema() {
  return {
    safeParse(input: unknown) {
      if (input === "true" || input === true) {
        return { data: true, success: true as const }
      }
      if (input === "false" || input === false) {
        return { data: false, success: true as const }
      }
      return { error: new Error("Expected boolean"), success: false as const }
    },
  }
}
