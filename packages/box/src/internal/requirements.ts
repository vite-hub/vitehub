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

export function boxRequirementSecrets(
  values: readonly (string | Uint8Array)[],
): readonly string[] {
  return values.map((value) =>
    typeof value === "string" ? value : new TextDecoder().decode(value)
  ).filter(Boolean);
}

export async function collectBoxRequirementOutput(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const patterns = [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length);
  const maximumSecretLength = Math.max(1, ...patterns.map(value => value.length));
  let pending = "";
  let output = "";
  let truncated = false;

  const append = (value: string) => {
    if (!value || truncated) return;
    if (output.length + value.length <= maximumDiagnosticLength) {
      output += value;
      return;
    }
    output = `${(output + value).slice(0, maximumDiagnosticLength - 1)}…`;
    truncated = true;
  };
  const flush = (final: boolean) => {
    while (pending && (final || pending.length >= maximumSecretLength)) {
      const secret = patterns.find(value => pending.startsWith(value));
      if (secret) {
        append("[redacted]");
        pending = pending.slice(secret.length);
      }
      else {
        append(pending[0]!);
        pending = pending.slice(1);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      flush(done);
      if (done) return output;
    }
  }
  finally {
    reader.releaseLock();
  }
}

export function boxRequirementError(
  requirement: ResolvedBoxRequirementInput,
  failure: unknown,
  secrets: readonly string[] = [],
  timeout: number | undefined = requirement.timeout,
  includeDiagnosticOutput = true,
): Error {
  const details = commandFailureDetails(failure, secrets, timeout, includeDiagnosticOutput);
  const name = diagnosticText(requirement.name, secrets);
  return new Error(`[vitehub] Box requirement "${name}" failed${details ? `: ${details}` : "."}`);
}

function commandFailureDetails(
  failure: unknown,
  secrets: readonly string[],
  timeout: number | undefined,
  includeDiagnosticOutput: boolean,
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
  const output = includeDiagnosticOutput
    ? diagnosticText(error?.stderr, secrets) || diagnosticText(error?.stdout, secrets)
    : "";
  const message = includeDiagnosticOutput && !output
    ? diagnosticText(error?.message ?? failure, secrets)
    : "";
  return [status, output || message].filter(Boolean).join(": ");
}

function diagnosticText(value: unknown, secrets: readonly string[]) {
  if (value === undefined || value === null) return "";
  const patterns = [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length);
  let text: string | undefined;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value, (_key, nested) =>
        typeof nested === "string" ? redactDiagnosticString(nested, patterns) : nested
      );
      text = redactDiagnosticJson(text, patterns);
    } catch {}
  }
  text ||= String(value);
  text = redactDiagnosticString(text, patterns);
  text = text.trim();
  if (text.length > maximumDiagnosticLength)
    text = `${text.slice(0, maximumDiagnosticLength - 1)}…`;
  return text;
}

function redactDiagnosticString(value: string, patterns: readonly string[]) {
  for (const secret of patterns) value = value.replaceAll(secret, "[redacted]");
  return value;
}

function redactDiagnosticJson(value: string, patterns: readonly string[]) {
  for (const secret of patterns) {
    const encoded = JSON.stringify(secret).slice(1, -1);
    value = value.replaceAll(encoded, "[redacted]");
  }
  return value;
}
