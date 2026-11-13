---
title: Edit and publish a page
description: Change a docs page in the Console, check the draft in the preview pane, publish it, and see the change on the site after the deploy.
navigation.order: 2
icon: i-lucide-file-pen-line
---

Every page of this site is a document in the **Docs** collection of the Console. The collection is `docsCollection()` from `@vite-hub/docs`, so the Console checks the frontmatter with the same schema as the build.

::steps{level="3"}
### Open the page

Open the pill on the page that you want to change and select **Content**. Or open [`/_vitehub/content`](/_vitehub/content), select **Docs**, and open the page.

### Edit the draft

Change the text or a frontmatter field, such as `description`. The Console saves a draft one second after you stop typing. One person edits a page at a time: on Workers the Console has no live room, so a second editor sees the page read-only and can select **Take over**.

### Check the preview

Select **Preview the page**. The preview pane renders the draft through the docs UI, with the same layout and components as the published page.

### Publish

Select **Publish**. The CMS marks the draft as the published version of the document.
::

::note
Today the CMS keeps the documents in R2 and D1, and the site renders the Markdown files of the repository. So a publish changes the published version in the Console and in `/api/content`, but not the page that readers see. When the site gets a GitHub token, the CMS switches to the GitHub store: a publish then commits the page to `main`, a GitHub Actions workflow builds and deploys the Worker again, and the change is live after about three minutes.

Blog posts, changelog releases, and authors are different: they exist only in the CMS, and the site reads the published version on each request. A publish of a post is live on [the blog](/blog) within a minute.
::

## What you cannot change here

- Search, the sidebar, and the previous and next links come from the last build. A new page shows in them after the deploy.
- A new section needs a `.navigation.yml` file, which the Console does not edit. Ask a developer, or let your agent open a pull request.
