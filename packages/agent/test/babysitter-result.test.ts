import { describe, expect, it } from "vitest";
import { babysitterPassResultSchema } from "../src/presets/babysitter.ts";

describe("Babysitter provider result", () => {
  it("keeps a park result when an older model omits or invents wait metadata", () => {
    const validate = (value: unknown) => babysitterPassResultSchema["~standard"].validate(value);
    expect(validate({ disposition: "park", text: "waiting", wait: { reason: "checks" } })).toEqual({
      value: { disposition: "park", text: "waiting" },
    });
    expect(validate({ disposition: "park", text: "waiting", wait: { kind: "evidence-changed" } })).toEqual({
      value: { disposition: "park", text: "waiting" },
    });
  });

  it("supplies a bounded text fallback when the provider omitted optional prose", () => {
    expect(babysitterPassResultSchema["~standard"].validate({ disposition: "retry" })).toEqual({
      value: { disposition: "retry", text: "Babysitter pass completed." },
    });
  });
});
