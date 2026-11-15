---
description: "Fix AGENT_UI_SPEC_NOT_FOUND in ViteHub when the model answers without JSON patch lines. Send the diagnostic back and ask for an Agent UI spec."
seo.title: "AGENT_UI_SPEC_NOT_FOUND: the answer has no spec"
---

`specFromText()` returns `AGENT_UI_SPEC_NOT_FOUND` when the model's answer has no spec patch. It does not throw: the diagnostic is in `result.diagnostics`, with `path: ""`.

## Why it happens

`catalogPrompt()` tells the model to answer with JSON patches, one on each line, such as `{"op":"add","path":"/root","value":"card"}`. `specFromText()` builds the spec from these lines and skips every other line. The answer has no patch when the model:

- answers with text only;
- sends the whole spec as one JSON object, often in a code fence;
- puts more than one patch on a line.

## Fix it

Send `result.diagnostics` back to the model as JSON and ask again for the whole spec. The `fix` of the diagnostic shows the patch format.

When the model answers often without patches, check that the instructions of the Agent hold `catalogPrompt()` for the same surface. Set `mode: 'inline'` when the model must write text before the spec.

## Related

- [`AGENT_UI_PATCH_INVALID`](/docs/agents/diagnostics/agent_ui_patch_invalid)
- [`AGENT_UI_SPEC_INVALID`](/docs/agents/diagnostics/agent_ui_spec_invalid)
