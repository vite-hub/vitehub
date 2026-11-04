// The `.zip` that the playground downloads, built in the browser. The files are a few kilobytes of text, so the
// archive stores them without compression and needs no library.
import { isProjectPath } from "./project-path";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** A stored `.zip` of text files under `folder/`, with the same bytes for the same files. */
export function zipFiles(files: Record<string, string>, folder: string): Uint8Array<ArrayBuffer> {
  if (!isProjectPath(folder) || !Object.keys(files).every(isProjectPath)) throw new Error("ZIP files must use safe project-relative paths.");
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const [path, contents] of entries) {
    const name = encoder.encode(`${folder}/${path}`);
    const data = encoder.encode(contents);
    const checksum = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034B50, true);
    header.setUint16(4, 20, true);
    // UTF-8 names.
    header.setUint16(6, 0x0800, true);
    header.setUint16(8, 0, true);
    // DOS date 1980-01-01.
    header.setUint16(12, 0x21, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, name.length, true);
    local.push(new Uint8Array(header.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014B50, true);
    // Identify Unix as the creator so Ubuntu's UnZip preserves UTF-8 names instead of converting them from DOS.
    entry.setUint16(4, 0x0314, true);
    new Uint8Array(entry.buffer).set(new Uint8Array(header.buffer, 4, 26), 6);
    entry.setUint32(38, 0o100644 << 16, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const directorySize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const zip = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let position = 0;
  for (const part of parts) {
    zip.set(part, position);
    position += part.length;
  }
  return zip;
}

/** Saves `files` as `<folder>.zip`. */
export function downloadZip(files: Record<string, string>, folder: string) {
  const url = URL.createObjectURL(new Blob([zipFiles(files, folder)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${folder}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
