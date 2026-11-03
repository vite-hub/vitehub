// Provider runtime events of a real docs assistant answer from a Codex Driver on the ChatGPT gateway (2026-11-02).
// Codex wrote a progress note, ran two commands, then wrote the answer. The runtime marks both messages "final".
const note = "msg_0e25e24c87ede5f5016ae89e5286148191bbba0b922a98c30d"
const answer = "msg_0e25e24c87ede5f5016ae89e5a45bc8191ac50f5db8fb0f4c8"
const read = "exec-174c9428-1f22-4a17-a583-651f7810bab0"
const search = "exec-59fea4cd-3f56-441e-ab0d-bd4a0f22d46c"
const readCommand = "/bin/bash -lc 'cat pages/docs/getting-started/install.md'"
const searchCommand = "/bin/bash -lc \"rg -n 'Node.js 22|Node 22|node.*22|22' pages\""
const noteText = "I’ll check the installation page for the commands and Node.js 22 behavior."
const answerText = "Install Lumen globally, then check the version:\n\n```sh\npnpm add -g lumen-cli\nlumen --version\n```\n\n**Node.js 22 and older are unsupported.** Installation fails with `LUMEN_E_NODE` on those versions.\n\nSource: [Install Lumen](/docs/getting-started/install)."
const installPage = "---\ntitle: Install Lumen\n---\n\n# Install Lumen\n\nLumen does not support Node.js 22 or older. The install fails with `LUMEN_E_NODE` on those versions.\n"

function codexDocsAnswerEvents(threadId: string) {
  const event = (type: string, payload: Record<string, unknown>, itemId?: string) => ({ itemId, payload, threadId, turnId: "turn-1", type })
  const message = (itemId: string, text: string, deltas: string[]) => [
    event("item.started", { data: { phase: "final" }, itemType: "assistant_message", status: "inProgress" }, itemId),
    ...deltas.map(delta => event("content.delta", { delta, streamKind: "assistant_text" }, itemId)),
    event("item.completed", { data: { phase: "final", text }, itemType: "assistant_message", status: "completed" }, itemId),
  ]
  const command = (itemId: string, input: string, output: string) => [
    event("item.started", { data: { command: input, toolName: "command_execution" }, itemType: "command_execution", status: "inProgress", title: input }, itemId),
    event("item.completed", { data: { command: input, exitCode: 0, output, toolName: "command_execution" }, itemType: "command_execution", status: "completed", title: input }, itemId),
  ]
  return [
    event("turn.started", {}),
    ...message(note, noteText, ["I’ll check the", " installation page for", " the", " commands", " and", " Node.js 22", " behavior."]),
    ...command(read, readCommand, installPage),
    ...command(search, searchCommand, "pages/docs/getting-started/install.md:21:Lumen does not support Node.js 22 or older.\n"),
    ...message(answer, answerText, [answerText.slice(0, 60), answerText.slice(60)]),
    event("turn.completed", { state: "completed" }),
  ]
}

export const codexDocsAnswer = { answerText, events: codexDocsAnswerEvents, noteText }
