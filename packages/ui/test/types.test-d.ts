import type { UIMessage } from "ai";
import { describe, it } from "vitest";
import {
  AgentCodeView,
  AgentFile,
  AgentFileDiff,
  AgentMultiFileDiff,
  AgentPatchDiff,
  AgentUnresolvedFile,
  getSingularPatch,
  type CodeViewItem,
  type FileContents,
} from "../src/index.ts";
import type { ViteHubUIMessage, ViteHubUISession } from "../src/index.ts";

declare const message: ViteHubUIMessage<{ createdAt: string }, { weather: { city: string } }>;

const patch = `--- a/ready.ts
+++ b/ready.ts
@@ -1 +1 @@
-false
+true`;

describe("UI types", () => {
  it("accepts code view items", () => {
    const file: FileContents = { contents: "export const ready = true\n", name: "ready.ts" };
    const fileDiff = getSingularPatch(patch);
    const codeViewItems: CodeViewItem<unknown>[] = [
      { file, id: "file", type: "file" },
      { fileDiff, id: "diff", type: "diff" },
    ];

    void AgentCodeView;
    void AgentFile;
    void AgentFileDiff;
    void AgentMultiFileDiff;
    void AgentPatchDiff;
    void AgentUnresolvedFile;
    void codeViewItems;
  });
});

const compatible: UIMessage = message;
const session: ViteHubUISession<typeof message> = { id: "session-1", messages: [message] };

void compatible;
void session;
