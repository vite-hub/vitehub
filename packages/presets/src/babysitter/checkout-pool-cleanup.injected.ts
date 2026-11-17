// Source text that `cleanBabysitterCheckoutPool()` runs in a child Node process (`node --eval`), where the presets catalog does not load.
// Its error stays plain. The host finds this message in the child's stderr and throws PRESETS_BABYSITTER_CHECKOUT_POOL_REPLACED.
export const checkoutPoolReplacedMessage = "Refusing to clean replaced Babysitter checkout pool";

/** Removes every entry of the cwd, after it checks that the cwd is still the claimed checkout pool (dev and inode in argv). */
export const cleanCheckoutPoolScript = `
  import { lstat, readdir, rm } from "node:fs/promises";
  const info = await lstat(".", { bigint: true });
  if (String(info.dev) !== process.argv[1] || String(info.ino) !== process.argv[2]) {
    throw new Error(${JSON.stringify(checkoutPoolReplacedMessage)});
  }
  for (const entry of await readdir(".")) {
    await rm(entry, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
`;
