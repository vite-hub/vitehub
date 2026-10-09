import { AgentsLanding } from "./agents";
import { WorkspaceLanding } from "./workspace";
import { SandboxLanding } from "./sandbox";
import { ConnectionsLanding } from "./connections";
import { WorkflowLanding } from "./workflows";
import { KvLanding } from "./kv";
import { DatabasesLanding } from "./databases";
import { QueueLanding } from "./queue";
import { ScheduleLanding } from "./schedule";
import { BlobLanding } from "./blob";
import { AuthLanding } from "./auth";
import { BrowserLanding } from "./browser";
import { ShellLanding } from "./shell";
import { SourceLanding } from "./source";
import { ContentLanding } from "./content";
import { EmailLanding } from "./email";
import { ChannelsLanding } from "./channels";
import { EnvLanding } from "./env";
import { RateLimitsLanding } from "./rate-limits";
import { RealtimeLanding } from "./realtime";
import type { PrimitiveLanding } from "./types";

export const primitiveLandings: Record<string, PrimitiveLanding> = Object.fromEntries([
  AgentsLanding,
  WorkspaceLanding,
  SandboxLanding,
  ConnectionsLanding,
  WorkflowLanding,
  KvLanding,
  DatabasesLanding,
  QueueLanding,
  ScheduleLanding,
  BlobLanding,
  AuthLanding,
  BrowserLanding,
  ShellLanding,
  SourceLanding,
  ContentLanding,
  EmailLanding,
  ChannelsLanding,
  EnvLanding,
  RateLimitsLanding,
  RealtimeLanding,
].map((landing) => [landing.slug, landing]));

export function getPrimitiveLanding(slug: string): PrimitiveLanding | undefined {
  return Object.hasOwn(primitiveLandings, slug) ? primitiveLandings[slug] : undefined;
}
