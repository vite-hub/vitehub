The Agent definitions of the projects that use ViteHub, with their private values replaced. Each file keeps the shape
that Workspace discovery reads: imports, statement style, templates, and the keys of `defineAgent()`. The test copies
each project to a temporary folder and removes the `.txt` suffix.

The quiver-agents `duplicates` Agent is `server/channels/airtable/duplicates.ts` in that project. It is a folder Agent
here so that discovery reads its shape.
