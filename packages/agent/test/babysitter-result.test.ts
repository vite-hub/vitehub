import { describe, expect, it } from "vitest";
import { babysitterPassResultSchema } from "../src/presets/babysitter.ts";
import {
  createBabysitterPassResultSchema,
  type BabysitterResultDiagnostic,
} from "../src/presets/babysitter/result.ts";

describe("Babysitter provider result", () => {
  it("reports malformed supplied coordination fields without rejecting useful output", () => {
    const diagnostics: BabysitterResultDiagnostic[] = [];
    const schema = createBabysitterPassResultSchema((value) => diagnostics.push(value));
    expect(
      schema["~standard"].validate({
        disposition: "park",
        text: "Repair pushed",
        wait: { kind: "checks" },
        reviewedHead: "unknown",
        waitForChecksHead: "unknown",
      }),
    ).toEqual({ value: { disposition: "park", text: "Repair pushed" } });
    expect(diagnostics).toEqual([
      { code: "invalid-wait", field: "wait" },
      { code: "invalid-reviewed-head", field: "reviewedHead" },
      { code: "invalid-check-head", field: "waitForChecksHead" },
    ]);
  });

  it("does not warn for omitted hints and reports invalid external dependency identities", () => {
    const diagnostics: BabysitterResultDiagnostic[] = [];
    const schema = createBabysitterPassResultSchema((value) => diagnostics.push(value));
    schema["~standard"].validate({ disposition: "retry" });
    expect(diagnostics).toEqual([]);
    expect(
      schema["~standard"].validate({
        disposition: "park",
        wait: {
          kind: "external",
          reason: "Permission needs an operator action",
          wake: { kind: "checks", repository: "invalid", headSha: "a".repeat(40) },
        },
      }),
    ).toEqual({
      value: {
        disposition: "park",
        text: "Babysitter pass completed.",
        wait: { kind: "external", reason: "Permission needs an operator action" },
      },
    });
    expect(diagnostics).toEqual([{ code: "invalid-wake", field: "wait.wake" }]);
  });
  it("keeps a park result when an older model omits or invents wait metadata", () => {
    const validate = (value: unknown) => babysitterPassResultSchema["~standard"].validate(value);
    expect(validate({ disposition: "park", text: "waiting", wait: { reason: "checks" } })).toEqual({
      value: { disposition: "park", text: "waiting" },
    });
    expect(
      validate({ disposition: "park", text: "waiting", wait: { kind: "evidence-changed" } }),
    ).toEqual({
      value: { disposition: "park", text: "waiting" },
    });
  });

  it("supplies a bounded text fallback when the provider omitted optional prose", () => {
    expect(babysitterPassResultSchema["~standard"].validate({ disposition: "retry" })).toEqual({
      value: { disposition: "retry", text: "Babysitter pass completed." },
    });
  });
});
