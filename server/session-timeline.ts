import type { SessionTimelineEvent } from './session-snapshots.ts'

type Observation = {
  attributes?: Record<string, unknown>
  name: string
  sequence: number
  timestamp: string
  type: string
}

export function sessionTimelineObservations(events: readonly SessionTimelineEvent[], observations: readonly Observation[]) {
  const before = events.filter(event => event.phase !== 'after')
  const after = events.filter(event => event.phase === 'after')
  const lastSequence = observations.reduce((maximum, observation) => Math.max(maximum, observation.sequence), -1)
  return [
    ...before.map((entry, index) => timelineObservation(entry, index - before.length)),
    ...observations,
    ...after.map((entry, index) => timelineObservation(entry, lastSequence + index + 1)),
  ]
}

function timelineObservation(entry: SessionTimelineEvent, sequence: number) {
  const group = entry.group ?? (entry.name.startsWith('babysitter.github.') ? 'github-lifecycle' : undefined)
  const label = entry.label ?? legacyGitHubLabel(entry.name)
  return {
    attributes: {
      'step.id': `babysitter.timeline.${sequence}.${entry.name}`,
      'vitehub.activity.detail': entry.detail,
      'vitehub.activity.group': group,
      'vitehub.activity.kind': entry.kind ?? 'preparation',
      'vitehub.activity.title': entry.title,
      'vitehub.inspect.target': entry.inspector,
      ...(label ? {
        'github.label.color': label.color,
        'github.label.name': label.name,
        'github.label.operation': label.operation,
      } : {}),
      ...(entry.delivery ? {
        'channel.effect.intent': entry.delivery.intent,
        'channel.effect.kind': entry.delivery.kind,
      } : {}),
    },
    name: entry.name,
    sequence,
    timestamp: entry.timestamp,
    type: 'lifecycle' as const,
  }
}

function legacyGitHubLabel(name: string): SessionTimelineEvent['label'] {
  if (name === 'babysitter.github.label.queued') {
    return { color: 'd0d7de', name: 'Agent: Queued', operation: 'added' }
  }
  if (name === 'babysitter.github.label.working') {
    return { color: '54aeff', name: 'Agent: Working', operation: 'added' }
  }
  if (name === 'babysitter.github.labels.cleared') {
    return { color: '54aeff', name: 'Agent: Working', operation: 'removed' }
  }
}
