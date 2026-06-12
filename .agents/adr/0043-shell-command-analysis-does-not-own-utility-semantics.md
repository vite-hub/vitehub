# Shell Command Analysis Does Not Own Utility Semantics

ViteHub may parse shell commands for **Command Analysis**, policy routing, scope enforcement, approval prompts, and guardrails, but Workspace inspection helpers must not implement ad hoc shell utility semantics. Shell command semantics belong inside **Shell Runtime** **Execution Providers**, or in explicitly structured **Workspace Tools** when the operation is not actually shell execution. Provider optimizations for common commands are allowed only when they are boundary-declared, compatibility-tested, and fall back to normal provider execution outside their supported subset.

## Considered Options

- Workspace-level `ls` and `find` fast paths were rejected because they drift into partial shell utility emulation and create recurring compatibility debt around flags, glob expansion, path display, dotfiles, malformed predicates, and shell runtime fallback.
- Parser-backed **Command Analysis** was kept because it can produce facts for policy and routing without pretending to execute a command.
- Provider-owned fast paths remain allowed because the **Execution Provider** is the boundary that owns command semantics and can declare its compatibility limits.
