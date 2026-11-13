import { gunzipSync } from "node:zlib";

import { workspaceError } from "../../core/errors.ts";

/** One regular file of a GitHub archive. `path` is from the repository root, without the archive's top folder. */
export interface TarFile {
  path: string;
  content: Uint8Array;
}

const decoder = new TextDecoder();

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** The `path` record of a PAX header, which GitHub writes for paths longer than the ustar fields. */
function paxPath(content: Uint8Array): string | undefined {
  let index = 0;
  while (index < content.length) {
    let space = index;
    while (space < content.length && content[space] !== 32) space++;
    const length = Number.parseInt(decoder.decode(content.subarray(index, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || index + length > content.length) return undefined;
    const record = decoder.decode(content.subarray(space + 1, index + length - 1));
    if (record.startsWith("path=")) return record.slice(5);
    index += length;
  }
}

/** The regular files of a GitHub `tar.gz` archive. Other entries, such as symlinks and folders, are left out. */
export function readTarGz(archive: Uint8Array): TarFile[] {
  const tar = gunzipSync(archive);
  const files: TarFile[] = [];
  let offset = 0;
  let longPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw workspaceError("[vitehub] GitHub workspace returned a malformed archive.");
    const start = offset + 512;
    const end = start + Math.ceil(size / 512) * 512;
    if (end > tar.length) throw workspaceError("[vitehub] GitHub workspace returned a malformed archive.");
    const content = tar.subarray(start, start + size);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x") longPath = paxPath(content);
    else {
      if (type === "0" || type === "\0") {
        const prefix = text(header.subarray(345, 500));
        const name = longPath ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/");
        const slash = name.indexOf("/");
        if (slash > 0 && slash < name.length - 1) files.push({ path: name.slice(slash + 1), content: new Uint8Array(content) });
      }
      longPath = undefined;
    }
    offset = end;
  }
  return files;
}
