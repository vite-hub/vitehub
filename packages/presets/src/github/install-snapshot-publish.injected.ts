// Source text that `publishGitHubInstallSnapshot()` runs in a child Node process (`node --eval`), where the presets catalog does not load.
// Its errors stay plain. The host finds these messages in the child's stderr and throws the matching catalog code.
export const outputChangedMessage = "Dependency output directory changed during installation.";
export const yarnOutputInvalidMessage = "Yarn output directory must not be a symbolic link.";
export const yarnOutputChangedMessage = "Yarn output directory changed during installation.";

/** Moves the outputs named in argv from the snapshot into the cwd, after it checks that the cwd is still the snapshot's directory. */
export const publishOutputScript = `
  import { lstat, mkdir, rename, rm } from "node:fs/promises";
  import { join } from "node:path";
  const [dev, ino, source, names, yarn] = process.argv.slice(1);
  const info = await lstat(".", { bigint: true });
  if (String(info.dev) !== dev || String(info.ino) !== ino) throw new Error(${JSON.stringify(outputChangedMessage)});
  const outputs = JSON.parse(names);
  const present = await Promise.all(outputs.map(name => lstat(join(source, name)).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })));
  if (yarn === "true") {
    if (!present.some(Boolean) && !await lstat(".yarn").catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    })) process.exit(0);
    await mkdir(".yarn").catch(error => { if (error.code !== "EEXIST") throw error; });
    const expected = await lstat(".yarn", { bigint: true });
    if (!expected.isDirectory()) throw new Error(${JSON.stringify(yarnOutputInvalidMessage)});
    process.chdir(".yarn");
    const actual = await lstat(".", { bigint: true });
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(${JSON.stringify(yarnOutputChangedMessage)});
  }
  for (const [index, name] of outputs.entries()) {
    await rm(name, { recursive: true, force: true });
    if (present[index]) await rename(join(source, name), name);
  }
`;
