---
description: "Fix MCP_ELICITATION_CLIENT_UNSUPPORTED in ViteHub. A tool calls elicit(), but the MCP client cannot ask the person for input."
seo.title: "MCP_ELICITATION_CLIENT_UNSUPPORTED: client cannot elicit"
---

`elicit()` of an MCP tool throws `MCP_ELICITATION_CLIENT_UNSUPPORTED`. The tool wants to ask the person for values, but the MCP client did not declare the `elicitation` capability when it connected. The Agent reads the code and the message as a tool error.

## Why it happens

A client that can show a form to the person says so in `initialize` with `capabilities.elicitation`. MCP does not let a server send `elicitation/create` to a client that did not declare it. Some clients, and most scripts, do not declare it.

## Fix it

Use an MCP client that supports elicitation in form mode.

To keep the tool useful in every client, accept the values as optional tool arguments too, and call `elicit()` only when they are missing. Then the Agent can ask the person in the chat and pass the values.

## Related

- [Ask the person for values](/docs/mcp/server-api#ask-the-person-for-values)
- [MCP server limits and errors](/docs/mcp/limits-and-errors)
