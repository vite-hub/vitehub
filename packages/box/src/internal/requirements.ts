import type { BoxResolvedRequirement, ResolvedBoxRequirementInput } from "../index.ts";

const maximumDiagnosticLength = 4_000;

export function boxRequirementPlan(
  requirements: readonly ResolvedBoxRequirementInput[],
): readonly BoxResolvedRequirement[] {
  return requirements.map(({ command, name, timeout }) => ({
    command,
    name,
    ...(timeout === undefined ? {} : { timeout }),
  }));
}

export function boxRequirementSignal(
  requirement: ResolvedBoxRequirementInput,
  signal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (requirement.timeout === undefined) return signal;
  const timeout = AbortSignal.timeout(requirement.timeout);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function boxRequirementError(
  requirement: ResolvedBoxRequirementInput,
  failure: unknown,
  secrets: readonly string[] = [],
  timeout: number | undefined = requirement.timeout,
): Error {
  const details = commandFailureDetails(failure, secrets, timeout);
  const name = diagnosticText(requirement.name, secrets);
  return new Error(`[vitehub] Box requirement "${name}" failed${details ? `: ${details}` : "."}`);
}

function commandFailureDetails(
  failure: unknown,
  secrets: readonly string[],
  timeout: number | undefined,
) {
  const error =
    failure && typeof failure === "object" ? (failure as Record<string, unknown>) : undefined;
  const timedOut =
    error?.name === "TimeoutError" || error?.code === "ETIMEDOUT" || error?.killed === true;
  const status =
    timedOut && timeout !== undefined
      ? `timed out after ${timeout}ms`
      : typeof error?.exitCode === "number"
        ? `exit code ${error.exitCode}`
        : typeof error?.code === "number"
          ? `exit code ${error.code}`
          : typeof error?.signal === "string"
            ? `terminated by ${error.signal}`
            : error?.name === "AbortError"
              ? "aborted"
              : "";
  const output = diagnosticText(error?.stderr, secrets) || diagnosticText(error?.stdout, secrets);
  const message = status || output ? "" : diagnosticText(error?.message ?? failure, secrets);
  return [status, output || message].filter(Boolean).join(": ");
}

function diagnosticText(value: unknown, secrets: readonly string[]) {
  if (value === undefined || value === null) return "";
  let text = String(value).trim();
  for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  if (text.length > maximumDiagnosticLength) text = `${text.slice(0, maximumDiagnosticLength)}…`;
  return text;
}
