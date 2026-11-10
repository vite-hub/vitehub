import { isProjectPath } from "./paths.ts";

/** Files by project-relative path. */
export type PlaygroundFiles = Record<string, string>;

/** What a share link holds: the template the files start from, and the files. */
export interface PlaygroundState {
  /** The id of the template. A playground without templates leaves it out, and its files start from nothing. */
  template?: string;
  files: PlaygroundFiles;
}

/** A template that a link can start from. */
export interface PlaygroundTemplate {
  id: string;
  files: PlaygroundFiles;
}

/**
 * The longest share link, in characters. Chat apps and issue trackers cut longer URLs, and a link this long already
 * holds about 60 KB of code. A bigger playground goes out as a zip.
 */
export const playgroundLinkLimit = 16_000;

/** The URL hash key that holds the files, as in `/play#code=…`. */
export const playgroundHashKey = "code";

// A link can hold at most `playgroundLinkLimit` characters, so honest files inflate to far less than this.
const inflatedLimit = 2 * 2 ** 20;

/** Only the differences from the template go into the link: `f` holds new and changed files, `d` removed paths. */
interface Payload {
  t?: string;
  f?: PlaygroundFiles;
  d?: string[];
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates at most `inflatedLimit` bytes, so a crafted link cannot fill the memory of the tab. */
async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > inflatedLimit) {
      await reader.cancel();
      throw new Error("The shared files are too big.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Encodes the files as their differences from `base`, the files of the template, compressed for a URL hash.
 * It runs in browsers and in Node, so a build can write playground links too.
 */
export async function encodePlaygroundLink(state: PlaygroundState, base: PlaygroundFiles = {}): Promise<string> {
  const changed = Object.fromEntries(Object.entries(state.files).filter(([path, contents]) => base[path] !== contents));
  const removed = Object.keys(base).filter(path => !Object.hasOwn(state.files, path));
  const payload: Payload = {
    ...state.template !== undefined && { t: state.template },
    ...Object.keys(changed).length > 0 && { f: changed },
    ...removed.length > 0 && { d: removed },
  };
  return toBase64Url(await deflate(JSON.stringify(payload)));
}

function isFiles(value: unknown): value is PlaygroundFiles {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([path, contents]) => isProjectPath(path) && typeof contents === "string");
}

/**
 * Reads a share code back into files. A malformed code, an unsafe path, or a template that is not in `templates` gives
 * `undefined`.
 */
export async function decodePlaygroundLink(code: string, templates: readonly PlaygroundTemplate[] = []): Promise<PlaygroundState | undefined> {
  try {
    const payload: unknown = JSON.parse(await inflate(fromBase64Url(code)));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const { t, f = {}, d = [] } = payload as Payload;
    const template = t === undefined ? undefined : templates.find(candidate => candidate.id === t);
    if ((t !== undefined && !template) || !isFiles(f) || !Array.isArray(d) || !d.every(path => typeof path === "string" && isProjectPath(path))) return undefined;
    const files = { ...template?.files, ...f };
    for (const path of d) delete files[path];
    return template ? { template: template.id, files } : { files };
  }
  catch {
    return undefined;
  }
}

/** The share code in a URL hash such as `#code=…`, or `undefined`. */
export function readPlaygroundHash(hash: string): string | undefined {
  return new URLSearchParams(hash.replace(/^#/, "")).get(playgroundHashKey) || undefined;
}

/** The link to `path` that opens `code`, such as `/play#code=…`. */
export function playgroundUrl(path: string, code: string): string {
  return `${path}#${playgroundHashKey}=${code}`;
}
