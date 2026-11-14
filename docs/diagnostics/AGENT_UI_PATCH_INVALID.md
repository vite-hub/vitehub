---
description: "Fix AGENT_UI_PATCH_INVALID in ViteHub. A JSON patch line of the model's answer cannot build the Agent UI spec. Send the diagnostic back to the model."
seo.title: "AGENT_UI_PATCH_INVALID: a patch cannot build the spec"
---

`specFromText()` returns `AGENT_UI_PATCH_INVALID` when one patch line of the model's answer cannot apply. It does not throw. The message gives the line number and the problem, and `path` is the `path` of the patch.

## Why it happens

`specFromText()` applies the patches of the answer in order, and stops at the first patch that:

- uses the key `__proto__`, `constructor`, or `prototype` in its `path` or `from`. These keys can change `Object.prototype` on the server, so `specFromText()` refuses them;
- has a `path` or `from` that is not a string;
- is a `test` patch whose value does not match;
- adds a value under a value that is not an object, such as under `null`.

## Fix it

Send the diagnostics back to the model and ask again for the whole spec. The `fix` of the diagnostic shows a correct patch. A patch path names keys of the spec only: `root`, `elements`, `state`, and the keys under them.

## Related

- [`AGENT_UI_SPEC_NOT_FOUND`](/docs/agents/diagnostics/agent_ui_spec_not_found)
- [`AGENT_UI_SPEC_INVALID`](/docs/agents/diagnostics/agent_ui_spec_invalid)
