---
title: The Console and the pill
description: Sign in, open the tools pill on any page, and use the Console sections for Content, Comments, and Auth.
navigation.order: 1
icon: i-lucide-panels-top-left
---

The ViteHub Console is the admin of this site. It runs in the same Worker at [`/_vitehub`](/_vitehub). Only signed-in users with a CMS role can open it.

::steps{level="3"}
### Sign in

Open [`/_vitehub/sign-in`](/_vitehub/sign-in) and sign in with your email and password, or select **Create one** to make an account. GitHub sign-in shows on the same page when the site has a GitHub OAuth App. Only the site owner's GitHub account gets the `admin` role. Other accounts get no CMS role until an admin gives them one in the Auth section.

### Open the pill

Go back to any docs page. A small pill shows at the bottom of the page when you are signed in. It has one button for each tool: **Console**, **Content**, and **Comments**.

### Open a tool

Select **Console** or **Content** in the pill. The tool opens in a window over the page, so you can read the page and the tool at the same time. The first button at the top right of the window opens the same view in a browser tab, with the same URL.
::

## Sections

| Section | Path | Use |
| --- | --- | --- |
| Content | `/_vitehub/content` | Edit, preview, and publish the docs pages. |
| Comments | `/_vitehub/comments` | Read, reply to, and resolve the comments on the pages. |
| Auth | `/_vitehub/auth` | See the users, their sessions, and their roles. Change a role. |

The URL of each Console page keeps its state, such as the open document or the filters of a list. Copy the URL to share the same view with another editor.

::agent-only
The Console sections that a user sees come from `server/console-authorize.ts`, which uses `cmsConsoleAuthorize`. An `admin` sees every section. A `publisher` or `editor` sees Content and Comments. A `user` without a CMS role gets `403`.
::

## Roles

| Role | Can |
| --- | --- |
| `admin` | Everything, also roles in the Auth section. |
| `publisher` | Edit, publish, comment, and delete comment threads. |
| `editor` | Edit drafts and comment. |
| `commenter` | Read drafts and comment. |
| `user` | Read the public site only. |
