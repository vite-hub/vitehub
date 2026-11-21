---
description: "Fix AGENT_FORMS_INVALID in ViteHub. forms() got a value that is not a form, a name that cannot be a tool name, or an empty title."
seo.title: "AGENT_FORMS_INVALID: invalid form in forms()"
---

`forms()` from `vite-hub/agent/capabilities` throws `AGENT_FORMS_INVALID` when you define the Agent. The message names the form and the problem.

## Why it happens

Each form gives the Agent one tool, `ask_<name>`. `forms()` checks each entry:

- There is at least one form.
- The name is lowercase letters, digits, and underscores, such as `expense`, so `ask_<name>` is a valid tool name.
- The value is a `defineForm()` result, a Standard Schema object, or `{ form, title }`.
- A `title` is a non-empty string.

## Fix it

```diff [server/agents/expenses.ts]
 export default defineAgent({
-  capabilities: [forms({ 'Expense claim': { schema: expense } })],
+  capabilities: [forms({ expense: { form: expense, title: 'Expense claim' } })],
 })
```

## Related

- [Ask a person to fill in a form](/docs/agents/channels#ask-a-person-to-fill-in-a-form)
- [One schema on every surface](/docs/forms/server-api)
