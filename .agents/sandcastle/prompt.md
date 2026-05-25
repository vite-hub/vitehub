# Context

You are working in the ViteHub repository on one GitHub issue.

Issue:
{{ISSUE_JSON}}

Current branch:
{{CURRENT_BRANCH}}

Recent commits:
{{RECENT_COMMITS}}

# Task

Implement the issue contract exactly. Keep the change scoped to the issue. Do not merge PRs. Do not post issue or PR comments.

Before editing, read the issue body, linked ADRs, and relevant `.agents` context files. Follow the repository's `AGENTS.md` instructions.

Run the expected proof from the issue body. If a proof command is unavailable or too broad for this sandbox, run the narrowest credible package tests and explain the gap in the final response.

Commit the implementation using a conventional commit message.

# Done

When the issue objective is complete, the proof has been run, and the implementation commit exists on the branch, output `<promise>COMPLETE</promise>` to signal early termination.
