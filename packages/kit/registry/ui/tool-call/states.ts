export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export const toolCallStates: Record<ToolCallState, { label: string; tone: "default" | "info" | "warning" | "success" | "error" }> = {
  "input-streaming": { label: "Preparing", tone: "default" },
  "input-available": { label: "Running", tone: "info" },
  "approval-requested": { label: "Needs approval", tone: "warning" },
  "approval-responded": { label: "Approved", tone: "info" },
  "output-available": { label: "Done", tone: "success" },
  "output-error": { label: "Failed", tone: "error" },
  "output-denied": { label: "Denied", tone: "error" },
};
