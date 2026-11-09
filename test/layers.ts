export const testLayerIncludes = Object.freeze({
  contracts: ["test/*.test.ts"],
  consumer: ["test/consumer/**/*.test.ts"],
  output: ["test/output/**/*.test.ts"],
  // Package suites also own app fixtures that they run in a child test process.
  packages: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test-d.ts", "packages/*/fixtures/*/test/**/*.test.ts"],
});

export function testLayersFor(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const layers = [];

  if (/^test\/[^/]+\.test\.ts$/.test(normalized)) {
    layers.push("contracts");
  }
  if (/^test\/consumer\/.+\.test\.ts$/.test(normalized)) {
    layers.push("consumer");
  }
  if (/^test\/output\/.+\.test\.ts$/.test(normalized)) {
    layers.push("output");
  }
  if (/^packages\/[^/]+\/(?:fixtures\/[^/]+\/)?test\/.+\.test(?:-d)?\.ts$/.test(normalized)) {
    layers.push("packages");
  }

  return layers;
}
