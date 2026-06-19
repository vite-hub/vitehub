# Git Capability Stays Local To Workspace Git

ViteHub exposes `git()` as an official Agent Capability for bounded source-history and local Workspace Session git state access rather than hiding Git under `workspaceShell()`. Public authority remains coarse `read`/`write`, and remote publication stays outside this capability until Workspace materialization, source ownership, credentials, and actor trust have a dedicated boundary.
