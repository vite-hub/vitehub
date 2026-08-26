#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const liveSmokeProviders = Object.freeze(["cloudflare", "vercel"]);
export const liveSmokeStages = Object.freeze(["preflight", "provision", "build", "deploy", "runtime"]);

const conclusions = Object.freeze(["success", "failure", "cancelled"]);
const issueLabel = "live-smoke-failure";
const issueTitle = "Live Smoke failure";

export function createStageEvidence({
  provider,
  currentStage,
  conclusion,
  runId,
  runAttempt,
  runUrl,
  observedAt = new Date().toISOString(),
  reason,
}) {
  assertAllowed(provider, liveSmokeProviders, "provider");
  assertAllowed(currentStage, liveSmokeStages, "stage");
  assertAllowed(conclusion, conclusions, "conclusion");
  if (conclusion === "success" && currentStage !== "runtime") {
    throw new Error("a successful provider run must reach the runtime stage");
  }
  if (!runId || !runUrl || !Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error("runId, runUrl, and a positive integer runAttempt are required");
  }
  assertTimestamp(observedAt);

  const currentIndex = liveSmokeStages.indexOf(currentStage);
  const stages = Object.fromEntries(liveSmokeStages.map((stage, index) => {
    if (index < currentIndex) return [stage, "success"];
    if (index > currentIndex) return [stage, "skipped"];
    return [stage, conclusion];
  }));

  const evidence = {
    schemaVersion: 1,
    provider,
    currentStage,
    conclusion,
    observedAt,
    stages,
    run: { id: String(runId), attempt: runAttempt, url: runUrl },
  };
  if (reason) evidence.reason = reason;
  return evidence;
}

export function aggregateStageEvidence({
  evidence,
  setupStatus,
  attemptProviders,
  runId,
  runAttempt,
  runUrl,
  observedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(attemptProviders) || new Set(attemptProviders).size !== attemptProviders.length) {
    throw new Error("attemptProviders must be a unique provider list");
  }
  for (const provider of attemptProviders) assertAllowed(provider, liveSmokeProviders, "attempt provider");
  assertTimestamp(observedAt);
  const byProvider = new Map();
  for (const entry of evidence) {
    validateEvidence(entry);
    if (entry.run.id !== String(runId) || entry.run.attempt > runAttempt) {
      throw new Error(`stage evidence for ${entry.provider} belongs to another run`);
    }
    const previous = byProvider.get(entry.provider);
    if (previous?.run.attempt === entry.run.attempt) {
      throw new Error(`duplicate evidence for ${entry.provider}`);
    }
    if (!previous || previous.run.attempt < entry.run.attempt) {
      byProvider.set(entry.provider, entry);
    }
  }

  const providers = liveSmokeProviders.map((provider) => {
    if (setupStatus !== "success") {
      return createStageEvidence({
        provider,
        currentStage: "preflight",
        conclusion: setupStatus === "cancelled" ? "cancelled" : "failure",
        runId,
        runAttempt,
        runUrl,
        observedAt,
        reason: `shared package build ${setupStatus}`,
      });
    }
    const entry = byProvider.get(provider);
    const providerRanThisAttempt = attemptProviders.includes(provider);
    if (entry && !(providerRanThisAttempt && entry.run.attempt < runAttempt)) {
      return entry.run.attempt === runAttempt
        ? entry
        : { ...entry, evidenceAttempt: entry.run.attempt, run: { id: String(runId), attempt: runAttempt, url: runUrl } };
    }
    return createStageEvidence({
      provider,
      currentStage: "preflight",
      conclusion: "failure",
      runId,
      runAttempt,
      runUrl,
      observedAt,
      reason: providerRanThisAttempt && entry
        ? "provider job failed without current-attempt stage evidence"
        : "provider stage evidence was not uploaded",
    });
  });

  return {
    schemaVersion: 1,
    conclusion: providers.every(provider => provider.conclusion === "success") ? "success" : "failure",
    observedAt,
    providers,
    run: { id: String(runId), attempt: runAttempt, url: runUrl },
  };
}

export async function updateLiveSmokeIssue({ github, context, report }) {
  validateReport(report);
  const marker = `<!-- vitehub-live-smoke-run:${report.run.id}:${report.run.attempt} -->`;
  const { data: openIssues } = await github.rest.issues.listForRepo({
    ...context.repo,
    labels: issueLabel,
    state: "open",
    per_page: 100,
  });
  const issue = openIssues.find(candidate => !candidate.pull_request);

  if (report.conclusion === "success") {
    if (!issue) return { action: "none" };
    const body = formatIssueUpdate(report, marker);
    if (!await issueHasMarker({ github, context, issue, marker })) {
      await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });
    }
    await github.rest.issues.update({
      ...context.repo,
      issue_number: issue.number,
      state: "closed",
      state_reason: "completed",
    });
    return { action: "closed", issueNumber: issue.number };
  }

  const body = formatIssueUpdate(report, marker);
  if (!issue) {
    const { data: created } = await github.rest.issues.create({
      ...context.repo,
      title: issueTitle,
      body,
      labels: [issueLabel],
    });
    return { action: "created", issueNumber: created.number };
  }
  if (await issueHasMarker({ github, context, issue, marker })) {
    return { action: "deduplicated", issueNumber: issue.number };
  }
  await github.rest.issues.createComment({ ...context.repo, issue_number: issue.number, body });
  return { action: "commented", issueNumber: issue.number };
}

function formatIssueUpdate(report, marker) {
  const summary = report.conclusion === "success"
    ? "Nightly Live Smoke passed for Cloudflare and Vercel. Closing this issue."
    : ["Nightly Live Smoke failed.", "", ...report.providers
        .filter(provider => provider.conclusion !== "success")
        .map(provider => `- ${provider.provider}: ${provider.currentStage} (${provider.conclusion})`)]
        .join("\n");
  return [
    marker,
    summary,
    "",
    `Run: ${report.run.url}`,
    "",
    "<details><summary>Stage evidence</summary>",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "</details>",
  ].join("\n");
}

async function issueHasMarker({ github, context, issue, marker }) {
  if (issue.body?.includes(marker)) return true;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: issue.number,
    per_page: 100,
  });
  return comments.some(comment => comment.body?.includes(marker));
}

function validateEvidence(evidence) {
  if (!evidence || evidence.schemaVersion !== 1) throw new Error("unsupported stage evidence");
  assertAllowed(evidence.provider, liveSmokeProviders, "provider");
  assertAllowed(evidence.currentStage, liveSmokeStages, "stage");
  assertAllowed(evidence.conclusion, conclusions, "conclusion");
  if (!evidence.run?.id || !evidence.run.url || !Number.isInteger(evidence.run.attempt)) {
    throw new Error("stage evidence has invalid run metadata");
  }
  assertTimestamp(evidence.observedAt);
}

function validateReport(report) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.providers)) {
    throw new Error("unsupported live smoke report");
  }
  assertTimestamp(report.observedAt);
  const providers = new Set();
  for (const evidence of report.providers) {
    validateEvidence(evidence);
    providers.add(evidence.provider);
    if (evidence.run.id !== report.run?.id || evidence.run.attempt !== report.run?.attempt) {
      throw new Error("provider evidence does not match the aggregate run");
    }
  }
  if (providers.size !== liveSmokeProviders.length || liveSmokeProviders.some(provider => !providers.has(provider))) {
    throw new Error("aggregate report must contain Cloudflare and Vercel evidence");
  }
  const conclusion = report.providers.every(provider => provider.conclusion === "success") ? "success" : "failure";
  if (report.conclusion !== conclusion) throw new Error("aggregate conclusion does not match provider evidence");
}

function assertAllowed(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

function assertTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`invalid observation timestamp: ${value}`);
  }
}

function readEvidence(directory) {
  const entries = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) entries.push(...readEvidence(path));
    else if (item.isFile() && item.name.endsWith(".json")) entries.push(JSON.parse(readFileSync(path, "utf8")));
  }
  return entries;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid option near ${flag ?? "end of input"}`);
    }
    const name = flag.slice(2);
    if (options[name] !== undefined) throw new Error(`duplicate option: ${flag}`);
    options[name] = value;
  }
  return options;
}

function runFromCommandLine(args) {
  const [command, ...optionArgs] = args;
  const options = parseOptions(optionArgs);
  const run = {
    runId: options["run-id"],
    runAttempt: Number(options["run-attempt"]),
    runUrl: options["run-url"],
    observedAt: options["observed-at"] ?? new Date().toISOString(),
  };
  if (command === "evidence") {
    return createStageEvidence({
      provider: options.provider,
      currentStage: options.stage,
      conclusion: options.conclusion,
      ...run,
    });
  }
  if (command === "aggregate") {
    if (!options.directory || !options["setup-status"] || options["attempt-providers"] === undefined) {
      throw new Error("aggregate requires --directory, --setup-status, and --attempt-providers");
    }
    return aggregateStageEvidence({
      attemptProviders: options["attempt-providers"] ? options["attempt-providers"].split(",") : [],
      evidence: readEvidence(resolve(options.directory)),
      setupStatus: options["setup-status"],
      ...run,
    });
  }
  throw new Error("usage: live-smoke-report.mjs evidence|aggregate [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(runFromCommandLine(process.argv.slice(2)), null, 2)}\n`);
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
