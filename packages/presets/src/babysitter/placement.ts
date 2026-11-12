import { Diagnostic } from "nostics";

import { presetsErrorDiagnostics } from "../error-diagnostics.ts";

/**
 * Thrown by `placement.place()` when no host can take the pass now. The pull request waits
 * `retryAfterMs` and is claimed again, without a failure or a no-progress strike.
 */
export class BabysitterPlacementCapacityError extends Diagnostic {
  constructor(reason: string, readonly retryAfterMs = 30_000) {
    const { code, docs, fix, why } = presetsErrorDiagnostics.PRESETS_BABYSITTER_PLACEMENT_CAPACITY({ reason });
    super({ code, docs, fix, why }, BabysitterPlacementCapacityError);
    this.name = "BabysitterPlacementCapacityError";
  }
}

/** Matches by name too, so an error from another copy of this package still counts. */
export function isBabysitterPlacementCapacityError(error: unknown): error is BabysitterPlacementCapacityError {
  return error instanceof Error && error.name === "BabysitterPlacementCapacityError";
}
