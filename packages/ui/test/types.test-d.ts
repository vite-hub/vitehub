import type { UIMessage } from "ai";
import { expectTypeOf, test } from "vitest";
import {
  CodeView,
  FileView,
  FileDiff,
  MultiFileDiff,
  PatchDiff,
  UnresolvedFile,
  TraceRun,
  getSingularPatch,
  type CodeViewItem,
  type FileContents,
  type TraceEventLogEntry,
  type TraceRunView,
  type TraceStepView,
} from "../src/index.ts";
import type { ViteHubUIMessage, ViteHubUISession } from "../src/index.ts";

const file: FileContents = { contents: "export const ready = true\n", name: "ready.ts" };
const fileDiff = getSingularPatch(`--- a/ready.ts
+++ b/ready.ts
@@ -1 +1 @@
-false
+true`);
const codeViewItems: CodeViewItem<unknown>[] = [
  { file, id: "file", type: "file" },
  { fileDiff, id: "diff", type: "diff" },
];

declare const message: ViteHubUIMessage<{ createdAt: string }, { weather: { city: string } }>;
const session: ViteHubUISession<typeof message> = { id: "session-1", messages: [message] };

const traceStep: TraceStepView = {
  events: [],
  id: "step-1",
  name: "Run focused tests",
  startTime: "2026-08-23T09:04:10.000Z",
  status: "completed",
  type: "run",
};
const traceRun: TraceRunView = {
  events: [],
  id: "run-1",
  startTime: "2026-08-23T09:04:10.000Z",
  status: "completed",
  steps: [traceStep],
};

test("types the diff views, chat messages and trace runs", () => {
  expectTypeOf([CodeView, FileView, FileDiff, MultiFileDiff, PatchDiff, UnresolvedFile]).not.toBeAny();
  expectTypeOf(codeViewItems).toEqualTypeOf<CodeViewItem<unknown>[]>();
  expectTypeOf(message).toExtend<UIMessage>();
  expectTypeOf(session).toExtend<ViteHubUISession<typeof message>>();
  expectTypeOf(traceRun).toExtend<InstanceType<typeof TraceRun>["$props"]["run"]>();
  expectTypeOf(traceRun.events).toExtend<TraceEventLogEntry[]>();
});
