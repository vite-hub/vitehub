import { formatDiagnostic } from "nostics"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { buildArtifact, contentHub } from "comark-content"
import comarkUi from "comark-ui/html"
import json from "comark-content/plugins/json"
import yaml from "comark-content/plugins/yaml"

import type {
  Cache,
  CacheArtifactOptions,
  ContentHub,
  ContentFile,
  ComarkContent,
  ContentOptions,
  ContentPlugin,
  Source as ComarkContentSource,
} from "comark-content"
import type { ContentListFile, ContentRegistry, RegistryData, SourceData } from "comark-content"
import { checkContentDocuments, contentCheckResult, parseContentFiles } from "./check.ts"
import type { ContentCheckFinding, ContentCheckInput, ContentCheckOptions, ContentCheckResult } from "./check.ts"
import { contentSource, contentSourceKeys, contentSourceKind, contentSourceRoute, contentSourceUrl, createContentInstance } from "./content-source.ts"
import { setContentSnapshotTargets, takeContentSnapshots } from "./snapshots.ts"
import { createContentHistory } from "./history.ts"
import type { ContentHistoryOptions, ContentHistoryResult } from "./history.ts"
import { createContentSourceHeads } from "./source-heads.ts"
import { createContentReadScope } from "./read-scope.ts"
import type { ContentSourceHeads } from "./source-heads.ts"
import type { ContentSourceRef } from "./source-refs.ts"
import type { ContentSnapshotTarget } from "./snapshots.ts"
import { contentMarkdownPreset } from "./html.ts"
import { collectionPathsOverlap, contentDocumentUrl, documentsRuntimeOf, isContentCollectionDefinition, parseDocumentFile } from "./documents.ts"
import { resolveContentPreset } from "./presets.ts"
import type { ContentPresetSelection } from "./presets.ts"
import { createContentPreview, createRequestScope } from "./preview.ts"
import { contentRefTokenParameter } from "./preview-parameters.ts"
import { parseContentPreviewPath, previewLink, previewLinkQuery, previewResponse, requestWithUrl, rewriteContentLinks } from "./ref-routes.ts"
import type { ContentPreviewLink, ContentPreviewLinkAccess, ContentSourcePreview, ContentSourcePreviewRoutes } from "./ref-routes.ts"
import { contentLabel, contentMarkdownCopy, contentMarkdownCopyPage, contentRoutedPages, contentSitemapEntries, markdownPrefix, normalizeSeoOptions, renderContentRobots, renderContentSitemap, renderMarkdownCopy, siteOrigin } from "./sitemap.ts"
import { contentPageCharacters, contentPageKey, contentPagePath, contentPagesLimit, contentPageSummary } from "./mcp.ts"
import { contentSearchSections } from "./search-sections.ts"
import { contentRssChannel, contentRssItems, contentRssLimit, renderContentRss } from "./rss.ts"
import { contentLlmsFile } from "./llms.ts"
import type { ContentLlmsOptions } from "./llms.ts"
import type {
  AnyContentCollection,
  ContentCollection,
  ContentDocument,
  ContentPublishPreview,
  ContentDocumentState,
  ContentDocumentStatus,
  ContentDocumentSummary,
  ContentListOptions,
  ContentPage,
  ContentPublishExpectation,
  ContentPublishMismatch,
  ContentPublishOptions,
  ContentResolved,
  ContentResolveOptions,
  ContentPublishResult,
  ContentPullRequest,
  ContentRawDocument,
  ContentReadOptions,
  ContentRef,
  ContentRevisionsOptions,
  ContentRevision,
  ContentRevisionsResult,
  ContentSingleton,
} from "./collections-types.ts"
import type { ContentSourceCommits, ContentSourceInput } from "./content-source.ts"
import type { ContentSearchSectionsOptions, ContentSourceSearchSection } from "./search-sections.ts"
import type { ContentCollectionDefinition, ContentFields, DocumentsDefinition, SingletonDefinition } from "./documents.ts"
import type { ContentPreview } from "./preview.ts"
import type {
  ContentPublishDueOptions,
  ContentPublishDueResult,
  ContentSchedule,
  ContentScheduleOptions,
  ContentSchedulesOptions,
  ContentUnscheduleOptions,
} from "./schedules.ts"
import type { ContentPageMarkdown, ContentPageSummary, ContentPagesOptions } from "./mcp.ts"
import type { ContentRoutedPage, ContentSitemapEntry, ContentSitemapOptions, DefineContentSeoOptions } from "./sitemap.ts"
import type { ContentCollectionsRuntime, ContentHistorySource } from "./collections-types.ts"
import type { ContentSessions } from "./sessions.ts"
export { contentSource } from "./content-source.ts"
export { contentCheckLimits, contentCheckRules } from "./check.ts"
export type { ContentCheckCode, ContentCheckFinding, ContentCheckOptions, ContentCheckResult, ContentCheckRule, ContentCheckSeverity } from "./check.ts"
export { defineContentTypesPlugin, generateContentTypes } from "./types.ts"
export type { ContentTypesHost, ContentTypesOptions } from "./types.ts"
/** Comark's registry interfaces. Generated Content types extend them through this module. */
export type { ContentListFile, ContentPathsRegistry, ContentRegistry, QueryRowBase } from "comark-content"
export { buildContentSnapshots, registerContentSnapshots } from "./snapshots.ts"
export type { BuiltContentCommit, BuiltContentSnapshot, ContentCommitSnapshotIndex, ContentSnapshot, ContentSnapshotIndex, ContentSnapshotLoader } from "./snapshots.ts"
export { renderContentHtml } from "./html.ts"
export { contentKeyVariable, contentPreviewCookieName, contentPreviewFrameParameter, contentPreviewPublishedParameter, contentRefTokenParameter, defineContentPreviewPlugin } from "./preview.ts"
export type { ContentPreview, ContentPreviewCookie, ContentPreviewDocument, ContentPreviewEvent, ContentPreviewFrame, ContentPreviewFrameOptions, ContentPreviewHost, ContentPreviewHostLoader, ContentPreviewOptions, ContentPreviewToken } from "./preview.ts"
export { contentScheduleOverdueMs, contentSchedulesRef } from "./defaults.ts"
export type {
  ContentDocumentSchedule,
  ContentPublishDueOptions,
  ContentPublishDueResult,
  ContentSchedule,
  ContentScheduledDocument,
  ContentScheduleFailure,
  ContentScheduleOptions,
  ContentSchedulesOptions,
  ContentScheduleStatus,
  ContentUnscheduleOptions,
} from "./schedules.ts"
export type { ContentSourceInput, ContentSourceMarkdown, ContentSourceMarkdownPage, ContentSourceOptions, ContentSourceReader, ContentSourceSeo } from "./content-source.ts"
export { registerContentKV } from "./kv.ts"
export type { ContentKV } from "./kv.ts"
export type { ContentHistoryEntry, ContentHistoryOptions, ContentHistoryResult } from "./history.ts"
export type { ContentSourceHead, ContentSourceHeadDiagnostic, ContentSourceHeads, ContentSourceView, ContentSourceWebhookDelivery } from "./source-heads.ts"
export { contentGitHubWebhookRoute, defineContentGitHubWebhookHandler } from "./github-webhook.ts"
export { defineContentPreviewRoutesPlugin, parseContentPreviewPath, rewriteContentLinks } from "./ref-routes.ts"
export type { ContentPreviewLink, ContentPreviewLinkAccess, ContentPreviewLinks, ContentPreviewLinksOptions, ContentPreviewPath, ContentPreviewRouteKind, ContentPreviewRoutesHost, ContentPreviewRoutesHostLoader, ContentSourcePreview, ContentSourcePreviewRoutes } from "./ref-routes.ts"
export type { ContentSourcePull, ContentSourceRef, ContentSourceRefKind } from "./source-refs.ts"
export type { ContentSourceAccess, ContentSourceAllowReason, ContentSourceDenyReason } from "./source-access.ts"
export { defineContentPreset } from "./presets.ts"
export type { ContentPreset, ContentPresetDefaults, ContentPresetSelection } from "./presets.ts"
export { contentSessionTimeouts } from "./defaults.ts"
export type {
  ContentDocumentSessions,
  ContentSession,
  ContentSessionAcquireOptions,
  ContentSessionOptions,
  ContentSessionReleaseOptions,
  ContentSessionReportOptions,
  ContentSessions,
  ContentSessionUser,
} from "./sessions.ts"
export { optional } from "./documents.ts"
export { contentSeoLengths, seo } from "./seo.ts"
// Blob owns the reference schemas. Content re-exports them so one import covers every field helper.
export { file, image } from "@vite-hub/blob"
export type { BlobReference, BlobReferenceOptions } from "@vite-hub/blob"
export type { ContentSeo, ContentSeoField, ContentSeoHint, ContentSeoOptions } from "./seo.ts"
export { contentHead, defaultContentImageUrl } from "./head.ts"
export { contentSearchSections } from "./search-sections.ts"
export type { ContentSearchSection, ContentSearchSectionsOptions, ContentSourceSearchSection } from "./search-sections.ts"
export { contentField, contentFieldAttribute, formatContentField, parseContentField } from "./field.ts"
export type { ContentFieldAddress } from "./field.ts"
export type {
  ContentHead,
  ContentHeadCollection,
  ContentHeadDefaults,
  ContentHeadDocument,
  ContentHeadLink,
  ContentHeadMeta,
  ContentHeadOptions,
  ContentHeadScript,
  ContentHeadSite,
} from "./head.ts"
export { renderContentRobots, renderContentSitemap } from "./sitemap.ts"
export type { ContentMarkdownOptions, ContentRssOptions, ContentSitemapEntry, ContentSitemapOptions, DefineContentLlmsOptions, DefineContentSeoOptions } from "./sitemap.ts"
export { renderContentRss } from "./rss.ts"
export { defineContentMcpHandler } from "./mcp.ts"
export type { ContentMcpOptions, ContentPageMarkdown, ContentPageSummary, ContentPagesOptions } from "./mcp.ts"
export type { ContentRssChannel, ContentRssItem } from "./rss.ts"
export { renderContentLlms, renderContentSitemapMarkdown } from "./llms.ts"
export type { ContentLlmsFile, ContentLlmsLink, ContentLlmsOptions, ContentLlmsSection, ContentSitemapMarkdownPage } from "./llms.ts"
export { acceptsMarkdown, defineContentMarkdownHandler, renderContentMarkdownNotFound } from "./markdown-negotiation.ts"
export type { ContentMarkdownErrorLink, ContentMarkdownRuntime, ContentMiddleware } from "./markdown-negotiation.ts"
export type {
  ContentCollectionDefinition,
  ContentDocumentUrl,
  ContentEditingOptions,
  ContentField,
  ContentFieldIssue,
  ContentFields,
  ContentFieldsInput,
  ContentFieldsOutput,
  ContentFormat,
  ContentLabel,
  DocumentComponent,
  DocumentComponentMediaProp,
  DocumentComponentProp,
  SingletonDefinition,
  SingletonOptions,
  DocumentsDefinition,
  DocumentsOptions,
} from "./documents.ts"
export type {
  AnyContentCollection,
  ContentAlternate,
  ContentCollection,
  ContentDerivedFrom,
  ContentDocument,
  ContentDocumentState,
  ContentDocumentStatus,
  ContentDocumentSummary,
  ContentListOptions,
  ContentPage,
  ContentPublishedDocument,
  ContentPublishExpectation,
  ContentPublishMismatch,
  ContentPublishOptions,
  ContentResolved,
  ContentResolveOptions,
  ContentPublishPreview,
  ContentPublishResult,
  ContentPullRequest,
  ContentRawDocument,
  ContentReadOptions,
  ContentRef,
  ContentRevisionsOptions,
  ContentRevision,
  ContentRevisionsResult,
  ContentSaveInput,
  ContentSingleton,
  ContentStatusOptions,
  ContentTranslationState,
  ContentWriteOptions,
} from "./collections-types.ts"

/** A Fetchable route: mount it on a Nitro or H3 route, or call `fetch(request)` directly. */
export interface ContentHandler {
  fetch(request: Request): Promise<Response>
}


type PluginMethods<TPlugin> = TPlugin extends ContentPlugin<infer TMethods, any> ? TMethods : unknown
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer TIntersection) => void
  ? TIntersection
  : never
type ContentMethods<TPlugins extends ReadonlyArray<ContentPlugin<any, any>>> =
  TPlugins["length"] extends 0 ? unknown : UnionToIntersection<PluginMethods<TPlugins[number]>>

/** What a Content surface asks permission for: reading drafts, saving or removing documents, or publishing. */
export type ContentAction = "read" | "write" | "publish"

/** The signed-in Auth user a surface passes to `authorize`, such as the Auth session user. */
export type ContentUser = Record<string, unknown>

/** The Actor of an Agent Invocation. It has the shape of an Agent Actor, so Content does not depend on the Agent package. */
export interface ContentActor {
  id: string
  kind?: "anonymous" | "chat" | (string & {})
  label?: string
  meta?: Record<string, unknown>
}

export interface ContentAuthorizeContext<TCollection extends string = string> {
  /** The signed-in Auth user, or null. An Agent passes the Auth user its Actor stands for, when there is one. */
  user: ContentUser | null
  /** The invoking Actor when an Agent makes the call, otherwise undefined. */
  actor?: ContentActor
  collection: TCollection
  action: ContentAction
  /** The document, when the action targets one. */
  id?: string
}

/** What `content.can()` takes. `user` defaults to null, so an Agent without an Auth user passes only `actor`. */
export type ContentCanContext<TCollection extends string = string> =
  Omit<ContentAuthorizeContext<TCollection>, "user"> & { user?: ContentUser | null | undefined }

/**
 * Decide whether a user or an Agent Actor may take a Content action. Surfaces such as the Console editor and the
 * Content Agent Capability call it through `content.can()`. The runtime methods themselves are trusted server API and do not.
 */
export type ContentAuthorize<TCollection extends string = string> =
  (context: ContentAuthorizeContext<TCollection>) => boolean | Promise<boolean>

type ContentCollections = Record<string, ContentCollectionDefinition<any>>
type CollectionName<TCollections> = Extract<keyof TCollections, string>
/** The runtime of one `collections` entry: a collection for `documents()`, a singleton for `singleton()`. */
type CollectionOf<TDefinition> =
  TDefinition extends SingletonDefinition<infer TFields> ? ContentSingleton<TFields>
    : TDefinition extends DocumentsDefinition<infer TFields> ? ContentCollection<TFields>
      : AnyContentCollection

export type DefineContentOptions<
  TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = ReadonlyArray<ContentPlugin<any, any>>,
  TCollections extends ContentCollections = ContentCollections,
  TPresetOptions extends object = object,
> = Omit<ContentOptions, "basePath" | "plugins" | "source" | "sources" | "markdown"> & {
  plugins?: TPlugins
  /**
   * Comark parser options. `plugins` add to Content's Comark UI preset, and a plugin with a preset plugin's name
   * replaces it. `preset: false` parses with `plugins` alone, for an app that brings its own Comark UI configuration.
   */
  markdown?: NonNullable<ContentOptions["markdown"]> & { preset?: false }
  /** Generate and serve `/api/content/**`. False keeps server methods and Console editing available. */
  route?: boolean
  /** One read-only Source, served as the `default` instance. */
  source?: ContentSourceInput
  /** Named read-only Sources. Each name becomes a Content instance. */
  sources?: Record<string, ContentSourceInput>
  /**
   * Preset that fills Definition options, such as `cms` from `vite-hub/cms`, or `[preset, options]`.
   * The `cms` preset sets `workspace`, so do not pass both.
   */
  extends?: ContentPresetSelection<TPresetOptions>
  /** Workspace that stores `collections`. It needs retained history, such as the Blob + Database Store. */
  workspace?: string
  /**
   * Editable collections, `documents()`, and singletons, `singleton()`. Each name becomes a Content instance that
   * serves the `published` ref.
   */
  collections?: TCollections
  /**
   * Policy for Content surfaces. It replaces the policy of the preset, such as the CMS roles of `cms`. Without either,
   * `content.can()` denies every action.
   */
  authorize?: ContentAuthorize<CollectionName<TCollections>>
  /**
   * Live co-editing of Markdown documents through Realtime. `auto` (default) turns it on when Realtime is enabled and
   * the host has a room authority, such as a Node server or Cloudflare Durable Objects; the room then holds the edit
   * lease for everyone in it. Other hosts, and `false`, keep one editor at a time.
   */
  live?: "auto" | false
  /**
   * Site-wide SEO routes. `sitemap: true` serves `/sitemap.xml` from the published documents of collections with a
   * `url` and the documents of Sources with a `url`; `robots: true` serves `/robots.txt`; `markdown: true` serves each
   * Markdown document of those collections at its URL plus `.md`, and at its URL for `Accept: text/markdown`;
   * `rss: true` serves `/rss.xml` with the newest Markdown pages; `mcp: true` serves a public read-only MCP server at
   * `/mcp` with `list-pages` and `get-page`; `llms: true` serves `/llms.txt`, `/llms-full.txt`, and `/sitemap.md`.
   * ViteHub generates the routes when this call sets them.
   */
  seo?: DefineContentSeoOptions
  /**
   * Options of `content.check()`. `advance()` runs its error rules before it moves the head of a `github()` Source.
   * `ignoreLinks` names link targets that other routes serve, such as `/docs/*\/diagnostics/**`. `site` defaults to
   * `seo.site`.
   */
  check?: ContentCheckOptions
  /**
   * Serve each allowed ref of the `github()` Source at a URL: `/tree/<branch>/-/<path>`, `/blob/<sha>/<path>`, and
   * `/pr/<number>/<path>`. ViteHub generates the routes when this call sets it. With more than one `github()` Source,
   * name the one to preview: `{ source: "docs" }`.
   */
  previews?: boolean | { source: string }
}

/** Document operations added by `collections`. */
export interface ContentDocumentsRuntime<TCollections extends ContentCollections = ContentCollections> {
  /**
   * Every collection and singleton in definition order, with its `name`, `kind`, `format`, `path`, `fields`, and
   * `schema`. Narrow an entry with `kind`. Empty without `collections`.
   */
  collections(): AnyContentCollection[]
  /** The revision id at the head of a ref, or null before the first revision. It changes with every save and publish. */
  head(ref: ContentRef): Promise<string | null>
  /** Open one collection or singleton to list, read, save, remove, restore, and compare documents. */
  collection<TName extends CollectionName<TCollections>>(name: TName): CollectionOf<TCollections[TName]>
  /** Copy draft documents to the `published` ref in one revision. Pass `expect` to publish exactly what was reviewed. */
  publish(options?: ContentPublishOptions<CollectionName<TCollections>>): Promise<ContentPublishResult>
  /** Whether the Workspace store supports scheduled publishing. False for the GitHub store; does not check for a Schedule runner. */
  supportsScheduling(): Promise<boolean>
  /**
   * The document that an app path shows, such as `/blog/hello`, or null. Each `documents()` collection maps a document
   * to a path with its `url`, and a document whose `url` is null does not resolve. A collection without `url` maps the
   * id after a slash, without a trailing `/index`. A query string, a hash, and a trailing slash are ignored. Use it to
   * link a page to its document, for example to an Edit button.
   */
  resolve(path: string, options?: ContentResolveOptions): Promise<ContentResolved<CollectionName<TCollections>> | null>
  /**
   * Publish exactly these reviewed drafts at a later time. The draft digests must match now. At its time,
   * `publishDue()` calls `publish({ expect })`; a draft saved after scheduling makes the schedule `failed` instead.
   */
  schedule(options: ContentScheduleOptions): Promise<ContentSchedule>
  /** Pending, overdue, and failed schedules, earliest first. Schedules that ran are removed; their publish revisions name them. */
  schedules(options?: ContentSchedulesOptions): Promise<ContentSchedule[]>
  /** Cancel a pending schedule, or dismiss a failed one. Throws `CONTENT_NOT_FOUND` when it already ran or is gone. */
  unschedule(id: string, options?: ContentUnscheduleOptions): Promise<void>
  /**
   * Run every pending or overdue schedule whose time has come. Call it from a Schedule Definition, such as one that
   * runs every minute. Runs are safe to overlap: each publish checks the reviewed digests, and each schedule settles once.
   */
  publishDue(options?: ContentPublishDueOptions): Promise<ContentPublishDueResult>
  /** Revisions that saved, removed, restored, or published one document, newest first. */
  revisions(collection: CollectionName<TCollections>, id: string, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** Revisions of a singleton defined with `singleton()`. */
  revisions(collection: CollectionName<TCollections>, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /**
   * Revisions that changed documents of any collection on one ref, newest first: saves, removes, and restores on
   * `draft` (default), publishes on `published`. `metadata.content.documents` names the documents of each.
   */
  revisions(options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /**
   * Presence and edit leases: who has a document open, and which session may edit it. Kept in the Database of the
   * Workspace history, which needs `contentSessionsSchema` from `vite-hub/content/database`.
   */
  readonly sessions: ContentSessions<CollectionName<TCollections>>
  /** Evaluate `defineContent({ authorize })`, or the policy of the preset. Returns false when there is no policy. */
  can(context: ContentCanContext<CollectionName<TCollections>>): Promise<boolean>
  /** Draft preview: a signed cookie that makes every Content read in its requests use the `draft` ref. */
  readonly preview: ContentPreview
  /** Whether the public Content HTTP route is enabled. Server methods and Console editing remain available. */
  readonly route: boolean
  /** `defineContent({ live })`: `auto` edits Markdown documents live where the host can, `false` never does. */
  readonly live: "auto" | false
  /**
   * Whether `defineContent({ authorize })` or its preset defines a policy. Without one, `can()` denies every action, so
   * surfaces such as the Console show no collections.
   */
  readonly hasPolicy: boolean
  /** `defineContent({ seo })`, or undefined. */
  readonly seo: DefineContentSeoOptions | undefined
  /**
   * The sitemap entries: published documents of collections with a `url`, without `noindex` ones or ones whose
   * canonical URL points elsewhere, then the documents of Sources with a `url`. `loc` is absolute when `site` is known.
   */
  sitemap(options?: ContentSitemapOptions): Promise<ContentSitemapEntry[]>
  /** The robots.txt text for `defineContent({ seo: { robots } })`. */
  robots(options?: ContentSitemapOptions): string
  /**
   * The RSS 2.0 feed of `defineContent({ seo: { rss } })`: the published Markdown pages that the sitemap lists, newest
   * first by the date of their latest `content.history()` entry. `site` defaults to `seo.site`, else
   * `http://localhost`.
   */
  rss(options?: ContentSitemapOptions): Promise<string>
  /**
   * The Markdown copy that a path such as `/blog/hello.md` names: the published document at `/blog/hello`, under its
   * title and description, with root-relative links made absolute when `site` is known. Null when no published
   * Markdown document has that URL.
   */
  markdown(path: string, options?: ContentSitemapOptions): Promise<string | null>
  /**
   * The published Markdown pages that the sitemap lists, as `{ title, path, description, url }`: collection documents
   * and the pages of Sources with a `url`, read at the head commit of a `github()` Source. At most 1,000 per call; pass
   * `offset` for more. The `list-pages` tool of `seo.mcp` returns them.
   */
  pages(options?: ContentPagesOptions): Promise<ContentPageSummary[]>
  /**
   * One page of `pages()` with its Markdown copy in `content`, or null when no listed page has that path. The path may
   * end in `.md` or be an absolute URL. The `get-page` tool of `seo.mcp` returns it.
   */
  page(path: string, options?: ContentSitemapOptions): Promise<ContentPageMarkdown | null>
  /**
   * A file for agents from the published Markdown documents with a URL, as `defineContent({ seo: { llms } })` serves
   * it: `llms.txt` (default), `llms-full.txt` with every page, or `sitemap.md`. Links point at the `.md` copies.
   */
  llms(options?: ContentLlmsOptions): Promise<string>
}

/**
 * `content.list()` with one name or a list of names. Generated Content types in `.vitehub/types/content.d.ts` type the
 * `data` of a named source or collection.
 */
export interface ContentRuntimeList {
  <TName extends keyof ContentRegistry & string>(names: TName | readonly TName[]): Promise<ContentListFile<SourceData<TName>>[]>
  (names?: string | readonly string[]): Promise<ContentListFile<RegistryData>[]>
}

/** Named-source operations retained across the Comark instance API migration. */
export type ContentRuntime = Omit<ContentHub<ComarkContent[]>, "list" | "search" | "media"> & {
  list: ContentRuntimeList
  /**
   * The head commit of each `github()` Source. With a GitHub token, Content serves one validated commit per Source, keeps
   * it in ViteHub KV, and moves it with `advance()`. Reads follow a moved head within 5 seconds.
   */
  sources: ContentSourceHeads & ContentSourcePreviewRoutes
  /**
   * The published history of the page at an app path, such as `/docs/guide`, newest first: `{ entries, cursor }`, with
   * entries of `{ id, at, author, message, url }`. Null when no page has that path. A collection document lists its
   * `published` revisions, never drafts. A `github()` Source page lists the commits that changed its file, up to the
   * commit that readers get. It is safe to show on a public page, for "last updated", RSS, or a history panel.
   */
  history(path: string, options?: ContentHistoryOptions): Promise<ContentHistoryResult | null>
  /**
   * Check the documents of the Sources, with no built HTML and no network: frontmatter against the Source `schema`,
   * links to pages that do not exist, links to missing headings, and the search rules of `@vite-hub/docs` (title and
   * description length, duplicates, heading order). A `github()` Source is checked at `sha`, or at the latest commit of
   * its branch, and its head does not move. `vitehub content check` prints the same result.
   */
  check(options?: { source?: string, sha?: string }): Promise<ContentCheckResult>
  search(names: string[], query: string, options?: Parameters<ContentHub["search"]>[1]): ReturnType<ContentHub["search"]>
  /**
   * Every document of the Sources split by heading, for a search that ranks in the browser or in another index. Each
   * part has its document's Source name and Content key, such as `docs/guide.md`. Works on every host, with no database.
   */
  searchSections(names?: string | readonly string[], options?: ContentSearchSectionsOptions): Promise<ContentSourceSearchSection[]>
  getSource(name?: string): ComarkContentSource | undefined
  cache: Omit<Cache, "keys" | "clear"> & {
    clear(name?: string): Promise<void>
    keys(name?: string): Promise<string[]>
    refresh(name: string): ReturnType<ComarkContent["refresh"]>
    snapshot(name: string, options?: CacheArtifactOptions): ReturnType<typeof buildArtifact>
  }
}

const contentActions: ReadonlySet<string> = new Set<ContentAction>(["read", "write", "publish"])

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
  const TCollections extends ContentCollections = {},
  TPresetOptions extends object = object,
>(options: DefineContentOptions<TPlugins, TCollections, TPresetOptions> = {}): ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> & ContentDocumentsRuntime<TCollections> {
  if (options.source && options.sources) throw new Error("Define either source or sources, not both.")
  if (options.extends !== undefined && options.workspace !== undefined) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ extends }) sets workspace. Remove workspace, or name the Workspace in the preset options." })
  }
  const { source, sources, collections, authorize, seo: seoOptions, check: checkOptions = {}, live = "auto", route = true, previews = false, ...sharedOptions } = options
  if (previews !== true && previews !== false && (Object(previews) !== previews || typeof previews.source !== "string")) {
    throw contentErrorDiagnostics.CONTENT_R0045({ message: "[vitehub] defineContent({ previews }) must be true, false, or { source: \"<github() Source name>\" }." })
  }
  if (live !== "auto" && live !== false) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ live }) must be 'auto' or false." })
  }
  const { preset, ...markdownOptions } = sharedOptions.markdown ?? {}
  const customPlugins = markdownOptions.plugins ?? []
  const replaced = new Set(customPlugins.filter(Boolean).map(plugin => plugin.name))
  const presetPlugins = preset === false ? [] : comarkUi(contentMarkdownPreset).plugins.filter(plugin => !replaced.has(plugin.name))
  sharedOptions.markdown = { ...markdownOptions, plugins: [...presetPlugins, ...customPlugins] }
  const seo = normalizeSeoOptions(seoOptions)
  const presetDefaults = options.extends === undefined ? {} : resolveContentPreset(options.extends)
  const workspace = options.workspace ?? presetDefaults.workspace
  if (authorize !== undefined && typeof authorize !== "function") {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ authorize }) must be a function." })
  }
  // The app's own policy wins over the preset's, such as the CMS roles of `cms`.
  const policy = authorize ?? presetDefaults.authorize
  for (const plugin of options.plugins ?? []) {
    if (isComarkParsePlugin(plugin)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] ${JSON.stringify(plugin.name)} is a Comark parse plugin, and defineContent({ plugins }) takes only Comark Content plugins. Pass it in defineContent({ markdown: { plugins } }).` })
    }
  }
  const collectionEntries = Object.entries(collections ?? {})
  for (const [name, definition] of collectionEntries) {
    if (!isContentCollectionDefinition(definition) || !documentsRuntimeOf(definition)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} must be defined with documents() or singleton() from @vite-hub/content/collections.` })
    }
  }
  for (let index = 0; index < collectionEntries.length; index++) {
    const [name, definition] = collectionEntries[index]!
    if (!isContentCollectionDefinition(definition)) continue
    for (const [otherName, otherDefinition] of collectionEntries.slice(index + 1)) {
      if (isContentCollectionDefinition(otherDefinition) && collectionPathsOverlap(definition, otherDefinition)) {
        throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection paths ${JSON.stringify(name)} (${definition.path}) and ${JSON.stringify(otherName)} (${otherDefinition.path}) overlap.` })
      }
    }
  }
  if (collectionEntries.length && (String(workspace) !== workspace || !workspace)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ collections }) requires extends: cms from vite-hub/cms, or workspace: the name of a Workspace with retained history." })
  }
  const inputs: Record<string, ContentSourceInput | undefined> = sources ?? (source || !collectionEntries.length ? { default: source } : {})
  // A build ships the parsed `glob()` Sources as `files()` Sources with snapshots, and the branch commit of each `github()`
  // Source for the commit cache. Collections stay editable, so they parse.
  const snapshots = takeContentSnapshots()
  const snapshotTargets: ContentSnapshotTarget[] = []
  const check: ContentCheckOptions = { ...checkOptions, ...(checkOptions.site ?? seo?.site ? { site: checkOptions.site ?? seo?.site } : {}) }
  // Custom plugin factories can hide options and implementations in closures. Reuse their files, then parse locally.
  const reuseParsed = !customPlugins.some(Boolean) && !options.plugins?.some(Boolean)
  const heads = createContentSourceHeads({ ...sharedOptions, basePath: "/api/content" }, {
    privateBranches: presetDefaults.privateBranches ?? [],
    check,
    targets: source => loadCheckTargets([source]),
  }, reuseParsed)
  /** How each `github()` Source reads its head commit, for the raw files of `content.page()`. */
  const sourceCommits = new Map<string, ContentSourceCommits>()

  async function loadCheckTargets(checked: readonly string[]): Promise<NonNullable<ContentCheckInput["targets"]>> {
    // Other Sources add link targets, but their availability must not reject an unrelated commit.
    // Retain failed Sources' URL scopes so links into them cannot silently become route warnings.
    const names = Object.keys(inputs).filter(name => !checked.includes(name))
    const loaded = await Promise.allSettled(names.map(async name => (await loadCheckInput(name, undefined, true)).input))
    return loaded.map((result, index) => {
      const name = names[index]!
      if (result.status === "fulfilled") return { ...result.value, ...(result.value.failures?.length ? { unavailable: name } : {}) }
      const url = contentSourceUrl(inputs[name])
      return { items: [], unavailable: name, ...(url === undefined ? {} : { url }) }
    })
  }

  async function loadCheckInput(name: string, sha?: string, published = false): Promise<{ sha: string | null, input: ContentCheckInput }> {
    if (heads.github(name)) return await heads.inspect(name, sha, published)
    const input = inputs[name]!
    const adapted = contentSource(input)
    const files = await Promise.all((await adapted.keys()).map(async key => ({ key, path: key, content: await adapted.getItem(key) })))
    const parsed = await parseContentFiles(name, files, { prefix: adapted.prefix, schema: adapted.schema }, { ...sharedOptions, basePath: "/api/content" }, true)
    const url = contentSourceUrl(input)
    return { sha: null, input: {
      source: name,
      files,
      items: parsed.commit?.items ?? [],
      failures: parsed.failures,
      ...(adapted.schema ? { schema: adapted.schema } : {}),
      ...(url === undefined ? {} : { url }),
      options: check,
    } }
  }
  const instances = Object.entries(inputs).map(([name, input]) => {
    if (!input) throw new Error(`Content source ${JSON.stringify(name)} is missing.`)
    const kind = contentSourceKind(input)
    const commits = heads.commits(name, input, snapshots?.[name])
    if (commits) sourceCommits.set(name, commits)
    const instance = createContentInstance(name, input, { ...sharedOptions, basePath: "/api/content" }, kind === "files" ? snapshots?.[name] : undefined, commits)
    heads.attach(name, instance)
    if (kind === "glob" || kind === "files") snapshotTargets.push({ name, instance, keys: () => contentSourceKeys(input) })
    else if (heads.github(name)) snapshotTargets.push({ name, instance, keys: async () => [], commit: () => heads.snapshot(name) })
    return instance
  })
  const preview = createContentPreview({ enabled: collectionEntries.length > 0 })
  /** The preview of the current request: the ref of its URL, and the commit that `allow()` checked. */
  /**
   * The ref of a preview request, its commit view, held open for the whole request, and the query that internal links
   * keep, such as a signed-link token.
   */
  const refScope = createRequestScope<{ target: ContentSourceRef, preview: ContentSourcePreview, view: ComarkContent, query?: string }>(previews !== false)
  const createCollections = collectionEntries[0] && documentsRuntimeOf(collectionEntries[0][1])
  const documentsRuntime: ContentCollectionsRuntime | undefined = createCollections
    ? createCollections({
        workspace: workspace!,
        // SAFETY: Each definition was checked with isContentCollectionDefinition() above.
        collections: Object.fromEntries(collectionEntries),
        defaultRef: () => preview.active() ? "draft" : "published",
        previewFrame: () => preview.frame(),
        live,
        ...(presetDefaults.publish ? { publish: presetDefaults.publish } : {}),
      })
    : undefined
  const collectionInstances: Array<{ instance: ComarkContent, source: ContentHistorySource }> = []
  for (const [name, definition] of collectionEntries) {
    if (Object.hasOwn(inputs, name)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} has the same name as a Content source.` })
    }
    const historySource = documentsRuntime!.comarkSource(name)
    // Comark parses Markdown by default. JSON and YAML collections get their parser first, so a configured plugin still wins.
    const format = definition.format === "json" ? json() : definition.format === "yaml" ? yaml() : undefined
    const configuredPlugins = sharedOptions.plugins ?? []
    const plugins = format && !configuredPlugins.some(plugin => plugin.name === format.name)
      ? [format, ...configuredPlugins]
      : configuredPlugins
    const instance = createContentInstance(name, historySource, { ...sharedOptions, plugins, basePath: "/api/content" })
    instances.push(instance)
    collectionInstances.push({ instance, source: historySource })
  }
  const hub = contentHub(instances, { basePath: "/api/content", logger: options.logger })
  const readScope = createContentReadScope(hub.names, hub.basePath)

  // A preview request reads a second hub whose collection instances are pinned to `draft` with their own cache namespace.
  let draft: { hub: ContentHub<ComarkContent[]>, instances: Array<{ instance: ComarkContent, source: ContentHistorySource }> } | undefined
  function draftHub() {
    if (!draft) {
      const pinned = hub.withRefs(Object.fromEntries(collectionEntries.map(([name]) => [name, "draft"])))
      const names = new Set(collectionEntries.map(([name]) => name))
      draft = {
        hub: pinned,
        // SAFETY: Collection instances read a ContentHistorySource, and withRef() pins it through comarkSource().
        instances: pinned.instances.filter(instance => names.has(instance.name)).map(instance => ({ instance, source: instance.getSource(instance.name) as ContentHistorySource })),
      }
    }
    return draft
  }

  // Loaded collection instances are refreshed when another writer, process, or host moved the head of their ref.
  const syncing = new Map<ContentRef, Promise<void>>()
  async function sync(ref: ContentRef): Promise<void> {
    if (!documentsRuntime) return
    let pending = syncing.get(ref)
    if (!pending) {
      pending = (async () => {
        const loaded = (ref === "draft" ? draftHub().instances : collectionInstances)
          .filter(({ instance }) => instance.status !== "created" && instance.status !== "disposed")
        if (!loaded.length) return
        const head = await documentsRuntime.head(ref)
        const stale: Array<Promise<unknown>> = []
        for (const { instance, source } of loaded) {
          if (source.loadedRevision !== head) stale.push(instance.refresh())
        }
        await Promise.all(stale)
      })().finally(() => {
        syncing.delete(ref)
      })
      syncing.set(ref, pending)
    }
    await pending
  }
  documentsRuntime?.onPublish(async (names) => {
    const refreshes: Array<Promise<unknown>> = []
    for (const { instance } of collectionInstances) {
      if (names.includes(instance.name) && instance.status !== "created" && instance.status !== "disposed") refreshes.push(instance.refresh())
    }
    await Promise.all(refreshes)
  })
  /** The hubs of preview requests: the hub of the request's ref with the Source instance replaced by its commit view. */
  const viewHubs = new WeakMap<ComarkContent, WeakMap<ContentHub<ComarkContent[]>, ContentHub<ComarkContent[]>>>()
  function viewHub(base: ContentHub<ComarkContent[]>, view: ComarkContent): ContentHub<ComarkContent[]> {
    let byBase = viewHubs.get(view)
    if (!byBase) viewHubs.set(view, byBase = new WeakMap())
    let composed = byBase.get(base)
    if (!composed) {
      composed = contentHub(base.instances.map(instance => instance.name === view.name ? view : instance), { basePath: "/api/content", logger: options.logger })
      byBase.set(base, composed)
    }
    return composed
  }
  /**
   * Run a read on the hub of the current request's ref after refreshing stale instances. In a preview request, the
   * `github()` Source reads the commit of the ref, and `rewrite` puts internal links of the result under the prefix.
   */
  function fresh<TArgs extends unknown[], TResult>(method: (target: ContentHub<ComarkContent[]>, ...args: TArgs) => Promise<TResult>, select: (...args: TArgs) => readonly string[] | undefined, rewrite?: (result: TResult, prefix: string, query: string | undefined) => TResult | Promise<TResult>): (...args: TArgs) => Promise<TResult> {
    return async (...args) => {
      // Comark can serve cached artifacts and shared indexes without calling guarded instance methods.
      await heads.sync(select(...args))
      let base = hub
      if (documentsRuntime && preview.active()) {
        await sync("draft")
        base = draftHub().hub
      }
      else await sync("published")
      const active = refScope.getStore()
      if (!active) return await method(base, ...args)
      const result = await heads.read(active.target, view => method(viewHub(base, view), ...args))
      return rewrite ? await rewrite(result, active.preview.prefix, active.query) : result
    }
  }
  /** The hub of a synchronous read: the commit view of a preview request, else the published hub. */
  function previewHub(): ContentHub<ComarkContent[]> {
    const view = refScope.getStore()?.view
    return view ? viewHub(hub, view) : hub
  }
  function requireDocuments(): ContentCollectionsRuntime {
    if (!documentsRuntime) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] This Content runtime has no collections. Add defineContent({ workspace, collections })." })
    }
    return documentsRuntime
  }
  const byName = new Map(instances.map(instance => [instance.name, instance]))
  function from(name: string) {
    const instance = byName.get(name)
    if (!instance) throw new Error(`Unknown content source ${JSON.stringify(name)}.`)
    return instance
  }
  function cacheForKey(key: string) {
    const instance = instances.find(candidate => key.startsWith(`${candidate.name}:`))
    if (!instance) throw new Error(`Unknown content cache key ${JSON.stringify(key)}.`)
    return instance.cache
  }
  const routedSources = Object.entries(inputs).flatMap(([name, input]) => {
    const route = contentSourceRoute(input)
    return route === undefined ? [] : [{ name, ...route, list: () => from(name).list() }]
  })
  /**
   * The routed pages, and the latest history date of each Source page. Content keeps the dates per head commit of each
   * `github()` Source. Shared atomic date leases can coordinate refreshes across server instances.
   */
  async function routedPages(site: string | undefined, waitUntil: ContentSitemapOptions["waitUntil"]): Promise<{ pages: ContentRoutedPage[], dates: Map<ContentRoutedPage, string> }> {
    const pages = await contentRoutedPages(documentsRuntime ? [...documentsRuntime.collections.values()] : [], site, routedSources)
    const dates = new Map<ContentRoutedPage, string>()
    await Promise.all([...new Set(routedSources.map(source => source.name))].map(async (name) => {
      const dated = pages.filter(page => page.collection === name && page.key !== undefined)
      const found = await historyApi.dates(name, dated.map(page => page.key!), waitUntil ? { waitUntil } : {})
      for (const page of dated) {
        const date = found.get(page.key!)
        if (date) dates.set(page, date)
      }
    }))
    return { pages, dates }
  }
  /** The text of one Source file: from the head commit of a `github()` Source, else from the Source as it is. */
  async function sourceText(name: string, key: string): Promise<string | null> {
    const commits = sourceCommits.get(name)
    const revision = await commits?.revision()
    let content: unknown
    if (commits && revision) content = (await commits.files(revision)).find(file => file.key === key || file.path === key)?.content
    else {
      const source = from(name).getSource(name)
      if (source && "getItem" in source) content = await source.getItem(key)
    }
    if (content instanceof Uint8Array) return new TextDecoder().decode(content)
    return String(content) === content ? content : null
  }
  /**
   * The Markdown copy of a routed page, from its published collection document or its Source file. A Source with
   * `contentSource(input, { markdown })` renders its own copy. `footer` adds the end that only the `.md` copy has.
   */
  async function pageMarkdown(page: ContentRoutedPage, site: string | undefined, footer = false): Promise<string | null> {
    if (page.key !== undefined) {
      const text = await sourceText(page.collection, page.key)
      if (text === null) return null
      const render = routedSources.find(source => source.name === page.collection)?.markdown
      if (render) {
        const copy = await render({ id: page.id, key: page.key, path: contentPagePath(page.loc, site), text, ...page.title ? { title: page.title } : {}, ...page.description ? { description: page.description } : {}, ...site ? { site } : {} })
        if (copy === null || typeof copy === "string") return copy
        return footer && copy.footer ? `${copy.markdown}${copy.footer}` : copy.markdown
      }
      const parsed = parseDocumentFile(text)
      if ("issues" in parsed) return null
      return await renderMarkdownCopy({ title: page.title, description: page.description, body: parsed.body }, site)
    }
    if (!documentsRuntime) return null
    const collection = documentsRuntime.collection(page.collection)
    const document = await collection.get(page.id, { ref: "published", ...(page.locale === undefined ? {} : { locale: page.locale }) })
    return document ? await renderMarkdownCopy({ title: page.title, description: page.description, body: document.body }, site) : null
  }
  /**
   * The routed Markdown pages that `content.pages()` lists. `all` adds the pages that indexes leave out, `noindex` ones
   * and ones whose canonical URL points elsewhere: they still have a Markdown copy.
   */
  async function markdownPages(site: string | undefined, all = false): Promise<ContentRoutedPage[]> {
    return (await contentRoutedPages(documentsRuntime ? [...documentsRuntime.collections.values()] : [], site, routedSources, { all })).filter(page => page.markdown)
  }
  /** The Source page whose Markdown copy is at `path`, such as `/docs/kv.md`, or with the `seo.markdown` prefix. */
  async function sourceCopyPage(path: string, site: string | undefined): Promise<ContentRoutedPage | undefined> {
    const page = contentMarkdownCopyPage(path, markdownPrefix(seo))
    if (page === undefined || !routedSources.length) return
    const key = contentPageKey(page)
    return (await contentRoutedPages([], site, routedSources, { all: true })).find(candidate => candidate.markdown && contentPageKey(contentPagePath(candidate.loc, site)) === key)
  }
  /** Compute the page dates of a `github()` Source at its new head, so no feed or sitemap request waits for them. */
  async function warmDates(name: string): Promise<void> {
    if (!seo?.sitemap && !seo?.rss) return
    const source = routedSources.filter(routed => routed.name === name)
    if (!source.length) return
    const pages = await contentRoutedPages([], undefined, source)
    await historyApi.refresh(name, pages.flatMap(page => page.key === undefined ? [] : [page.key]))
  }
  heads.onMove(warmDates)
  const configuredSite = seo?.site === undefined ? undefined : siteOrigin(seo.site)
  const siteFor = (sitemapOptions: ContentSitemapOptions = {}) => sitemapOptions.site === undefined ? configuredSite : siteOrigin(sitemapOptions.site)
  // SAFETY: collection() returns the runtime built from TCollections[TName], whose fields type its documents.
  const documentsApi = {
    preview,
    seo,
    live,
    route,
    hasPolicy: policy !== undefined,
    sitemap: async (sitemapOptions?: ContentSitemapOptions) => {
      const { pages, dates } = await routedPages(siteFor(sitemapOptions), sitemapOptions?.waitUntil)
      return contentSitemapEntries(pages, dates)
    },
    rss: async (rssOptions?: ContentSitemapOptions) => {
      const site = siteFor(rssOptions) ?? "http://localhost"
      const options = seo?.rss !== null && typeof seo?.rss === "object" ? seo.rss : {}
      const { pages, dates } = await routedPages(site, rssOptions?.waitUntil)
      return renderContentRss(contentRssChannel(options, site), contentRssItems(pages, dates, options.limit ?? contentRssLimit))
    },
    pages: async (pagesOptions: ContentPagesOptions = {}) => {
      const site = siteFor(pagesOptions) ?? "http://localhost"
      const offset = pagesOptions.offset ?? 0
      const limit = Math.min(pagesOptions.limit ?? contentPagesLimit, contentPagesLimit)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw contentErrorDiagnostics.CONTENT_R0070({ message: `[vitehub] content.pages() takes a whole offset of 0 or more and a limit from 1 to ${contentPagesLimit}.` })
      }
      return (await markdownPages(site)).slice(offset, offset + limit).map(page => contentPageSummary(page, site))
    },
    page: async (path: string, pageOptions?: ContentSitemapOptions) => {
      if (String(path) !== path) throw contentErrorDiagnostics.CONTENT_R0070({ message: "[vitehub] content.page() takes a page path such as /blog/hello." })
      const site = siteFor(pageOptions) ?? "http://localhost"
      const key = contentPageKey(path)
      // Like the `.md` copy, a `noindex` page is readable by its path, though `pages()` does not list it.
      const page = (await markdownPages(site, true)).find(candidate => contentPageKey(contentPagePath(candidate.loc, site)) === key)
      if (!page) return null
      let markdown = await pageMarkdown(page, site)
      if (markdown === null) return null
      if (markdown.length > contentPageCharacters) markdown = `${markdown.slice(0, contentPageCharacters)}\n\n[The page is longer than ${contentPageCharacters} characters and ends here. Open ${contentPageSummary(page, site).url} for the rest.]\n`
      return { ...contentPageSummary(page, site), content: markdown }
    },
    markdown: async (path: string, markdownOptions?: ContentSitemapOptions) => {
      const site = siteFor(markdownOptions)
      const prefix = markdownPrefix(seo)
      const copy = documentsRuntime ? await contentMarkdownCopy(documentsRuntime, prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path, site) : null
      if (copy !== null) return copy
      const page = await sourceCopyPage(path, site)
      return page ? await pageMarkdown(page, site, true) : null
    },
    llms: async (llmsOptions: ContentLlmsOptions = {}) => {
      const llms = seo?.llms
      const site = siteFor(llmsOptions)
      // One section per collection or Source, named by its label.
      const label = (page: ContentRoutedPage) => page.key === undefined && documentsRuntime
        ? documentsRuntime.collection(page.collection).label
        : routedSources.find(source => source.name === page.collection)?.label ?? contentLabel(page.collection)
      const pages = (await markdownPages(site)).map(page => ({ ...page, path: contentPagePath(page.loc, site), section: label(page) }))
      return await contentLlmsFile(pages, page => pageMarkdown(page, site), typeof llms === "object" ? llms : {}, site, llmsOptions.file ?? "llms.txt", markdownPrefix(seo))
    },
    robots: (sitemapOptions?: ContentSitemapOptions) => {
      const robots = seo?.robots
      return renderContentRobots({
        site: siteFor(sitemapOptions),
        sitemap: seo?.sitemap === true,
        disallow: robots !== null && Object(robots) === robots ? (robots as { disallow?: readonly string[] }).disallow : undefined,
      })
    },
    collections: () => documentsRuntime ? [...documentsRuntime.collections.values()] : [],
    head: async ref => documentsRuntime ? await documentsRuntime.head(ref) : null,
    // SAFETY: Each method forwards its arguments unchanged, so the overloads of ContentSessions hold.
    sessions: {
      report: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.report, undefined, args),
      acquire: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.acquire, undefined, args),
      release: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.release, undefined, args),
      list: (collection?: string) => requireDocuments().sessions.list(collection),
    } as ContentSessions,
    collection: (name: string): unknown => requireDocuments().collection(name),
    publish: async (publishOptions?: ContentPublishOptions) => await withPublishPreviews(await requireDocuments().publish(publishOptions)),
    resolve: (path: string, resolveOptions?: ContentResolveOptions) => requireDocuments().resolve(path, resolveOptions),
    supportsScheduling: () => requireDocuments().supportsScheduling(),
    schedule: (scheduleOptions: ContentScheduleOptions) => requireDocuments().schedule(scheduleOptions),
    schedules: (schedulesOptions?: ContentSchedulesOptions) => requireDocuments().schedules(schedulesOptions),
    unschedule: (id: string, unscheduleOptions?: ContentUnscheduleOptions) => requireDocuments().unschedule(id, unscheduleOptions),
    publishDue: (dueOptions?: ContentPublishDueOptions) => requireDocuments().publishDue(dueOptions),
    revisions: (collectionOrOptions?: string | ContentRevisionsOptions, id?: string | ContentRevisionsOptions, revisionOptions?: ContentRevisionsOptions) => {
      if (typeof collectionOrOptions !== "string") return requireDocuments().history(collectionOrOptions)
      // Without a string id, the second argument is the options of a singleton.
      return typeof id === "string" ? requireDocuments().revisions(collectionOrOptions, id, revisionOptions) : requireDocuments().revisions(collectionOrOptions, undefined, id)
    },
    async can(context: ContentCanContext<CollectionName<TCollections>>): Promise<boolean> {
      if (context === null || Object(context) !== context || !contentActions.has(context.action)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() requires { user?, actor?, collection, action: 'read' | 'write' | 'publish', id? }." })
      }
      const { user = null, actor, collection, action, id } = context
      if (user !== null && Object(user) !== user) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() user must be the Auth user object or null." })
      }
      if (actor !== undefined && (actor === null || Object(actor) !== actor || String(actor.id) !== actor.id)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() actor must be an Agent Actor with an id, or undefined." })
      }
      requireDocuments().collection(collection)
      if (!policy) return false
      const decision: ContentAuthorizeContext<CollectionName<TCollections>> = { user, collection, action }
      if (actor !== undefined) decision.actor = actor
      if (id !== undefined) decision.id = id
      return await policy(decision) === true
    },
  } as ContentDocumentsRuntime<TCollections>
  const sourceNames = Object.keys(inputs)
  /**
   * The published document that readers get at an app path: a routed collection document, or a singleton with a `url`.
   * A locale without a translation serves the source locale version, so its history is the history of that version.
   */
  async function publishedPage(documents: ContentCollectionsRuntime, path: string): Promise<ContentResolved | null> {
    let found = await documents.resolve(path, { ref: "published" })
    if (!found) {
      const target = pagePath(path)
      for (const collection of documents.collections.values()) {
        if (collection.kind !== "singleton" || !collection.routable) continue
        const document = await collection.get({ ref: "published" })
        if (document && String(document.url) === document.url && pagePath(document.url) === target) {
          found = { collection: collection.name, id: document.id }
          break
        }
      }
    }
    if (!found || found.locale === undefined) return found
    const served = await documents.collection(found.collection).get(found.id, { ref: "published", locale: found.locale })
    return served?.locale === undefined ? found : { ...found, locale: served.locale }
  }
  const historyApi = createContentHistory({
    ...(seo?.dateLeases ? { dateLeases: seo.dateLeases } : {}),
    ...(documentsRuntime ? { resolve: (path: string) => publishedPage(documentsRuntime, path) } : {}),
    revisions: (collection, id, revisionOptions) => requireDocuments().revisions(collection, id, revisionOptions),
    page: async (path) => {
      if (!sourceNames.length) return null
      const target = pagePath(path)
      const found = (await runtime.list(sourceNames)).find(file => pagePath(file.path) === target)
      if (!found) return null
      // Comark keys a file as `<source>/<Source key>`.
      const { source, key } = found.meta
      return { source, key: key.startsWith(`${source}/`) ? key.slice(source.length + 1) : key }
    },
    github: name => heads.github(name),
    published: name => heads.published(name),
  })
  /** The `github()` Source that preview URLs read: the one that `previews` names, or the only one. */
  function previewSource(): string {
    const names = heads.names()
    if (typeof previews === "object") {
      if (names.includes(previews.source)) return previews.source
      throw contentErrorDiagnostics.CONTENT_R0045({ message: `[vitehub] defineContent({ previews: { source: ${JSON.stringify(previews.source)} } }) names no github() Source. github() Sources: ${names.join(", ") || "none"}.` })
    }
    if (names.length === 1) return names[0]!
    throw contentErrorDiagnostics.CONTENT_R0045({ message: names.length
      ? `[vitehub] defineContent({ previews: true }) found more than one github() Source: ${names.join(", ")}. Name one with previews: { source }.`
      : "[vitehub] defineContent({ previews: true }) needs a github() Source in sources." })
  }
  /** A preview URL of an app path under `prefix`, absolute when a site is known, with the signed link token if any. */
  function previewUrl(prefix: string, path: string, site: string | undefined, token: string | undefined): string {
    const query = token === undefined ? undefined : `${contentRefTokenParameter}=${encodeURIComponent(token)}`
    const link = previewLink(path, prefix, query)
    return site === undefined ? link : new URL(link, site).href
  }
  /**
   * Add signed `/pr/<number>/<path>` links to a publish that opened a pull request, for each document with a `url`.
   * The pull request is already open, so a failure here only logs `CONTENT_R0076` and returns the result as it is.
   */
  async function withPublishPreviews(result: ContentPublishResult): Promise<ContentPublishResult> {
    const pull = result.pullRequest
    if (!pull || !result.revision || previews === false || !heads.names().length) return result
    try {
      const name = previewSource()
      const signed = await heads.api.sign(`pr/${pull.number}`, name)
      const documents = requireDocuments()
      const links: ContentPublishPreview[] = []
      for (const { collection, id, locale, change } of result.documents) {
        if (change === "delete") continue
        const definition = documents.collection(collection)
        const read = { revision: result.revision.id, ...(locale === undefined ? {} : { locale }) }
        const document = definition.kind === "singleton" ? await definition.get(read) : await definition.get(id, read)
        if (!document || String(document.url) !== document.url) continue
        links.push({ collection, id, ...(locale === undefined ? {} : { locale }), url: previewUrl(`/pr/${pull.number}`, document.url, configuredSite, signed.token), expiresAt: signed.expiresAt })
      }
      return links.length ? { ...result, previews: links } : result
    }
    catch (error) {
      console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0076({ pull: pull.number, reason: error instanceof Error ? error.message : String(error) })))
      return result
    }
  }
  const reportedDenials = new Set<string>()
  const previewRoutes: ContentSourcePreviewRoutes = {
    async previewLinks(pull, linkOptions = {}) {
      if (previews === false) throw contentErrorDiagnostics.CONTENT_R0079()
      if (!Number.isSafeInteger(pull) || pull < 1) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] content.sources.previewLinks() needs a pull request number, received ${JSON.stringify(pull)}.` })
      }
      const name = previewSource()
      const definition = heads.github(name)!
      const missing = (reason: string) => contentErrorDiagnostics.CONTENT_R0075({ source: name, pull, reason })
      if (!definition.pullChanges) throw missing("the github() Source cannot list the files of a pull request. Update @vite-hub/source")
      let view: Awaited<ReturnType<ContentSourceHeads["at"]>>
      try {
        view = await heads.api.at(`pr/${pull}`, name)
      }
      catch (error) {
        if (Reflect.get(Object(error), "code") === "CONTENT_R0028") throw missing("GitHub has no such pull request")
        throw error
      }
      // An anonymous request: what a reader of the pull request gets without a cookie or a link token.
      const decision = await heads.api.allow(view, new Request("https://vitehub.invalid/"), name)
      let access: ContentPreviewLinkAccess
      let signed: { token: string, expiresAt: Date } | undefined
      if (decision.allowed) access = decision.reason === "console" ? "token" : decision.reason
      else if (decision.reason === "private") {
        signed = await heads.api.sign(view.ref, name, linkOptions.maxAge === undefined ? undefined : { maxAge: linkOptions.maxAge })
        access = "token"
      }
      else if (decision.reason === "missing") throw missing("GitHub has no such pull request")
      else access = decision.reason
      const changed = await definition.pullChanges(pull)
      if (!changed) throw missing("GitHub has no such pull request")
      const keys = new Set(changed)
      const site = linkOptions.site === undefined ? configuredSite : siteOrigin(linkOptions.site)
      const pages: ContentPreviewLink[] = []
      const url = contentSourceUrl(inputs[name])
      for (const file of await view.list([name])) {
        // Comark keys a file as `<source>/<Source key>`.
        const key = file.meta.key.startsWith(`${name}/`) ? file.meta.key.slice(name.length + 1) : file.meta.key
        if (!keys.has(key)) continue
        const path = url === undefined ? file.path : contentDocumentUrl(url, { id: file.path.replace(/^\/+/, ""), data: file.data, key })
        if (path !== null) pages.push({ key, path, url: previewUrl(`/pr/${pull}`, path, site, signed?.token) })
      }
      pages.sort((left, right) => left.path.localeCompare(right.path))
      const fingerprint: unknown = definition.fingerprint
      const repo: unknown = typeof fingerprint === "object" && fingerprint !== null ? Reflect.get(fingerprint, "repo") : undefined
      return { source: name, repo: String(repo), sha: view.sha, pull: view.pull!, access, expiresAt: signed?.expiresAt ?? null, pages }
    },
    current: () => refScope.getStore()?.preview ?? null,
    async route(request, next) {
      const url = new URL(request.url)
      const parsed = previews === false ? null : parseContentPreviewPath(url.pathname)
      if (!parsed) return await next(request)
      const name = previewSource()
      const access = await heads.api.allow(parsed.ref, request, name)
      if (!access.allowed) {
        // The response must not tell a private ref from a missing one, so the app answers as for any unknown path.
        const key = `${name}:${parsed.ref}`
        if (!reportedDenials.has(key) && reportedDenials.size < 100) {
          reportedDenials.add(key)
          console.warn(formatDiagnostic(access.error))
        }
        return await next(request)
      }
      const site = configuredSite ?? url.origin
      const { target } = access
      const current: ContentSourcePreview = {
        source: target.source,
        ref: target.ref,
        kind: target.kind,
        sha: target.sha,
        pull: target.pull,
        route: parsed.route,
        prefix: parsed.prefix,
        path: parsed.path,
        url: new URL(parsed.path, site).href,
      }
      const page = new URL(url)
      page.pathname = parsed.path
      const query = previewLinkQuery(request.url, access.reason)
      // The commit view stays open for the whole request, so synchronous reads such as `from()` and `query()` use it.
      const response = await heads.read(target, async view => await refScope.run({ target, preview: current, view, ...(query ? { query } : {}) }, async () => await next(requestWithUrl(request, page.href))))
      return previewResponse(response, current, access.reason, request.url)
    },
  }
  const runtime: ContentRuntime & ContentDocumentsRuntime<TCollections> = {
    ...hub,
    ...documentsApi,
    get instances() { return previewHub().instances },
    sources: Object.assign(heads.api, previewRoutes),
    history: historyApi.history,
    async check(checkInput = {}) {
      const { source: only, sha } = checkInput
      if (only !== undefined && !Object.hasOwn(inputs, only)) throw contentErrorDiagnostics.CONTENT_R0069({ message: `[vitehub] content.check() found no Content source ${JSON.stringify(only)}. Sources: ${Object.keys(inputs).join(", ") || "none"}.` })
      const names = only === undefined ? Object.keys(inputs) : [only]
      if (sha !== undefined) {
        const github = names.filter(name => heads.github(name))
        if (github.length !== 1) throw contentErrorDiagnostics.CONTENT_R0069({ message: `[vitehub] content.check({ sha }) needs one github() Source. Name it with content.check({ source, sha }).` })
        names.splice(0, names.length, github[0]!)
      }
      const sources: ContentCheckResult["sources"] = []
      const findings: ContentCheckFinding[] = []
      // Checked Sources use their candidate commits; the rest contribute their published link targets.
      const loaded = new Map(await Promise.all(names.map(async name => [name, await loadCheckInput(name, sha)] as const)))
      const targets = await loadCheckTargets(names)
      for (const name of names) {
        const inspected = loaded.get(name)!
        const checked = checkContentDocuments({
          ...inspected.input,
          targets: [...targets, ...[...loaded].filter(([source]) => source !== name).map(([, value]) => value.input)],
        })
        sources.push({ source: name, sha: inspected.sha, pages: checked.pages })
        findings.push(...checked.findings)
      }
      return contentCheckResult(sources, findings)
    },
    // SAFETY: The wrapper forwards the path and options without changing the generic document result.
    get: fresh((target, key: string, opts?: Parameters<ContentHub["get"]>[1]) => target.get(key, opts), readScope.key, rewriteContentLinks) as ContentHub["get"],
    navigation: fresh((target, names?: Parameters<ContentHub["navigation"]>[0]) => target.navigation(names), readScope.names),
    handler: fresh((target, request: Request) => target.handler(request), readScope.request, rewriteJsonLinks),
    // SAFETY: The wrapper forwards the names unchanged, so Comark's registry types of the result hold.
    list: fresh((target, names?: string | readonly string[]) => target.list(names === undefined ? undefined : [names].flat()), readScope.names) as ContentRuntimeList,
    searchSections: fresh(async (target, names?: string | readonly string[], opts?: ContentSearchSectionsOptions) => {
      const sections: ContentSourceSearchSection[] = []
      const picked = names === undefined ? target.instances : [names].flat().map(name => target.from(name))
      // One parse of the whole Source, as full-text search indexes it, instead of one read per document.
      for (const instance of picked) {
        for (const file of (await instance.snapshot()).items) {
          if (file.meta.kind !== "document" || !file.nodes) continue
          const title = typeof file.data.title === "string" ? file.data.title : ""
          for (const section of contentSearchSections({ path: file.path, title, nodes: file.nodes }, opts))
            sections.push({ ...section, source: instance.name, key: file.meta.key })
        }
      }
      return sections
    }, readScope.names),
    search: fresh((target, names: string[], query: string, opts?: Parameters<ContentHub["search"]>[1]) => target.search(query, { ...opts, instances: names }), names => readScope.names(names)),
    manifest: fresh(target => target.manifest(), () => undefined),
    // The synchronous reads of a preview request use the commit view of its ref, as `get()` and `list()` do.
    stat: (key: string) => previewHub().stat(key),
    // SAFETY: Each wrapper forwards the name unchanged, so the generic builder and instance types of the hub hold.
    query: ((name: string) => previewHub().query(name)) as ContentRuntime["query"],
    from: ((name: string) => previewHub().from(name)) as ContentRuntime["from"],
    async dispose() {
      documentsRuntime?.dispose()
      // The draft hub shares every non-collection instance with `hub`, so dispose only its pinned collections.
      await Promise.all([heads.dispose(), hub.dispose(), ...(draft?.instances ?? []).map(({ instance }) => instance.dispose())])
    },
    getSource: (name = "default") => {
      const view = refScope.getStore()?.view
      return (view?.name === name ? view : byName.get(name))?.getSource(name)
    },
    cache: {
      get: <T = ContentFile>(key: string) => cacheForKey(key).get<T>(key),
      set: <T = ContentFile>(key: string, value: T) => cacheForKey(key).set(key, value),
      invalidate: (key: string) => cacheForKey(key).invalidate(key),
      expire: (key: string) => cacheForKey(key).expire(key),
      async clear(name?: string) {
        await Promise.all((name ? [from(name)] : instances).map(instance => instance.cache.clear()))
      },
      async keys(name?: string) {
        const selected = name ? [from(name)] : instances
        return (await Promise.all(selected.map(instance => instance.cache.keys()))).flat()
      },
      refresh: (name: string) => from(name).refresh(),
      async snapshot(name: string, opts?: CacheArtifactOptions) {
        const instance = from(name)
        const items = await instance.refresh()
        return buildArtifact(name, JSON.stringify({ items, time: Date.now() }), opts)
      },
    },
  }
  if (hub.media) Object.defineProperty(runtime, "media", { enumerable: true, get: () => previewHub().media })
  setContentSnapshotTargets(runtime, snapshotTargets)
  // Preserve custom plugin methods; Comark's hub owns cross-source search, query and media.
  for (const instance of instances) {
    for (const [key, value] of Object.entries(instance)) {
      if (!Object.hasOwn(runtime, key)) Object.defineProperty(runtime, key, {
        enumerable: true,
        get: () => {
          const view = refScope.getStore()?.view
          return view?.name === instance.name ? Reflect.get(view, key) : value
        },
      })
    }
  }
  // SAFETY: The instances install the declared plugin methods and the hub composes built-in methods.
  return runtime as ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> & ContentDocumentsRuntime<TCollections>
}

/** An app path without its query, hash, and trailing slash, in lower case, as Comark Content stores page paths. */
function pagePath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  return (bare.startsWith("/") ? bare : `/${bare}`).toLowerCase()
}

/**
 * Serve the Comark Content Web handler as a Fetchable route. With a Content runtime, a request with a valid preview
 * cookie reads the `draft` ref and gets `Cache-Control: private, no-store`.
 */
export function defineContentHandler(
  content: Pick<ComarkContent, "handler"> & { preview?: ContentPreview, route?: boolean },
): ContentHandler {
  return {
    async fetch(request) {
      if (content.route === false) return new Response("Not Found", { status: 404 })
      const dispatch = () => content.handler(request)
      return await (content.preview
        ? content.preview.run(request, dispatch)
        : dispatch())
    },
  }
}

type SeoRuntime = Pick<ContentDocumentsRuntime, "llms" | "markdown" | "robots" | "rss" | "seo" | "sitemap">

/**
 * The `waitUntil` of a request for `content.sitemap()` and `content.rss()`, and the `Cache-Control` of the answer. An
 * answer that left work for after the response has dates of the previous head, so no cache keeps it.
 */
function deferredWork(request: Request): { options: { waitUntil?: (promise: Promise<unknown>) => void }, cacheControl(): string } {
  const waitUntil = getStandardContext(request).waitUntil
  let deferred = false
  return {
    options: waitUntil
      ? {
          waitUntil: (promise) => {
            deferred = true
            waitUntil(promise)
          },
        }
      : {},
    cacheControl: () => deferred ? "no-store" : "public, max-age=0, must-revalidate",
  }
}

/**
 * Serve `/sitemap.xml` from `content.sitemap()`. URLs use `defineContent({ seo: { site } })`, or the request origin.
 * ViteHub generates this route when `defineContent({ seo: { sitemap: true } })`; mount it yourself in another server.
 */
export function defineContentSitemapHandler(content: SeoRuntime): ContentHandler {
  return {
    async fetch(request) {
      if (content.seo?.sitemap !== true) return new Response("Not Found", { status: 404 })
      const site = content.seo.site ?? new URL(request.url).origin
      const later = deferredWork(request)
      const xml = renderContentSitemap(await content.sitemap({ site, ...later.options }))
      return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": later.cacheControl() } })
    },
  }
}

/**
 * Serve `/rss.xml` from `content.rss()`. Links use `defineContent({ seo: { site } })`, or the request origin. ViteHub
 * generates this route when `defineContent({ seo: { rss: true } })`.
 */
export function defineContentRssHandler(content: SeoRuntime): ContentHandler {
  return {
    async fetch(request) {
      const rss = content.seo?.rss
      if (rss === undefined || rss === false) return new Response("Not Found", { status: 404 })
      const later = deferredWork(request)
      const xml = await content.rss({ site: content.seo?.site ?? new URL(request.url).origin, ...later.options })
      return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": later.cacheControl() } })
    },
  }
}

/**
 * Serve `/robots.txt` from `content.robots()`. It names `/sitemap.xml` when the sitemap is on. ViteHub generates this
 * route when `defineContent({ seo: { robots: true } })`.
 */
export function defineContentRobotsHandler(content: SeoRuntime): ContentHandler {
  return {
    async fetch(request) {
      const robots = content.seo?.robots
      if (robots === undefined || robots === false) return new Response("Not Found", { status: 404 })
      return new Response(content.robots({ site: content.seo?.site ?? new URL(request.url).origin }), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    },
  }
}

/**
 * Serve `/llms.txt`, `/llms-full.txt`, and `/sitemap.md` from `content.llms()`. The last path segment of the request
 * picks the file. ViteHub generates the three routes when `defineContent({ seo: { llms: true } })`.
 */
export function defineContentLlmsHandler(content: SeoRuntime): ContentHandler {
  return {
    async fetch(request) {
      const llms = content.seo?.llms
      const url = new URL(request.url)
      const file = (["llms.txt", "llms-full.txt", "sitemap.md"] as const).find(name => url.pathname.endsWith(`/${name}`))
      if (llms === undefined || llms === false || !file) return new Response("Not Found", { status: 404 })
      const text = await content.llms({ site: content.seo?.site ?? url.origin, file })
      return new Response(request.method === "HEAD" ? null : text, {
        headers: { "content-type": file === "sitemap.md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
      })
    },
  }
}

// Every Comark Content plugin field is optional, so a parse plugin type-checks in `plugins`, but Content never runs it there.
function isComarkParsePlugin(plugin: unknown): plugin is { name?: unknown } {
  if (typeof plugin !== "object" || plugin === null) return false
  return "pre" in plugin || "post" in plugin || "markdownItPlugins" in plugin
}

/** The JSON of `/api/content` with internal links under the preview prefix. Other responses stay as they are. */
async function rewriteJsonLinks(response: Response, prefix: string, query: string | undefined): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("json")) return response
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("etag")
  return new Response(JSON.stringify(rewriteContentLinks(await response.json(), prefix, query)), { status: response.status, statusText: response.statusText, headers })
}
