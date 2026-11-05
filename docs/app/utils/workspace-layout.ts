import type { WebContainerStage } from "@vite-hub/web-container";
import type { useWorkspace } from "@vite-hub/ui/workspace";

/** A 1px divider with a wider hit area. It highlights on hover and while it moves. */
export const splitterUi = {
  handle: "bg-(--ui-border) data-[orientation=horizontal]:w-px data-[orientation=vertical]:h-px data-[resize-handle-state=hover]:bg-(--ui-border-accented) data-[resize-handle-state=drag]:bg-(--ui-primary) transition-colors duration-150",
};

export const splitterHitArea = { coarse: 12, fine: 4 };

const stageLabels: Partial<Record<WebContainerStage, string>> = {
  checking: "Checking the browser",
  booting: "Starting WebContainer",
  mounting: "Loading files",
  installing: "Installing dependencies",
  starting: "Starting the dev server",
};

export type RunTone = "busy" | "ready" | "error";

/** One line that says what the workspace does now, for a toolbar. */
export function useRunState(workspace: ReturnType<typeof useWorkspace>) {
  return computed<{ tone: RunTone, label: string }>(() => {
    const failure = workspace.failure.value;
    if (failure) return { tone: "error", label: failure.kind === "install" ? "Install failed" : failure.kind === "server" ? "The dev server stopped" : "Did not start" };
    if (workspace.status.value === "ready" && workspace.previewUrl.value) return { tone: "ready", label: "Running" };
    return { tone: "busy", label: stageLabels[workspace.status.value as WebContainerStage] ?? "Starting" };
  });
}
