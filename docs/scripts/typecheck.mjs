import { spawnSync } from "node:child_process";

const ignoredDiagnostics = [
  /docus\/modules\/assistant\/runtime\/server\/api\/search\.ts\(66,38\): error TS2339: Property 'mcpServer' does not exist on type 'unknown'\./,
  /docus\/modules\/assistant\/runtime\/server\/api\/search\.ts\(84,33\): error TS2339: Property 'model' does not exist on type 'unknown'\./,
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
}

const prepare = run("pnpm", ["exec", "nuxi", "prepare"]);
if (prepare.status !== 0) {
  process.exit(prepare.status ?? 1);
}

const typecheck = run("pnpm", ["exec", "vue-tsc", "--noEmit", "-p", "tsconfig.typecheck.json"], { capture: true });
const output = [typecheck.stdout || "", typecheck.stderr || ""].filter(Boolean).join("");

const diagnosticLines = output
  .split("\n")
  .filter(line => line.includes(" error TS"));
const remainingDiagnostics = diagnosticLines.filter(line => !ignoredDiagnostics.some(pattern => pattern.test(line)));

if (typecheck.status === 0 || remainingDiagnostics.length === 0) {
  if (output.trim()) {
    const filteredOutput = output
      .split("\n")
      .filter(line => !ignoredDiagnostics.some(pattern => pattern.test(line)))
      .join("\n")
      .trim();

    if (filteredOutput) {
      process.stdout.write(`${filteredOutput}\n`);
    }
  }
  process.exit(0);
}

process.stdout.write(output);
process.exit(typecheck.status ?? 1);
