import { DomainError, invariant } from '../errors.ts';
import type { TelemetryEvent } from '../types.ts';

type EventContent = Pick<TelemetryEvent, 'sampleTimeMs' | 'sequence' | 'sensor' | 'value' | 'unit'> & {
  quality: TelemetryEvent['quality'] | null;
  channel: string | null;
};

type EventReport = {
  index: number;
  event: TelemetryEvent;
};

type EventContentGroup = {
  fingerprint: string;
  content: EventContent;
  reports: EventReport[];
};

type EventIdGroup = {
  byContent: Map<string, EventContentGroup>;
};

function eventContent(event: TelemetryEvent): EventContent {
  return {
    sampleTimeMs: event.sampleTimeMs,
    sequence: event.sequence,
    sensor: event.sensor,
    value: event.value,
    unit: event.unit,
    quality: event.quality ?? null,
    channel: event.channel ?? null,
  };
}

function contentFingerprint(event: TelemetryEvent): string {
  return JSON.stringify(eventContent(event));
}

export function validateTelemetry(events: TelemetryEvent[]): void {
  invariant(Array.isArray(events), 'INVALID_TELEMETRY', 'Telemetry events must be an array');
  for (const [index, event] of events.entries()) {
    invariant(event && typeof event.runId === 'string' && event.runId.length > 0, 'INVALID_RUN_ID', 'Telemetry run id is required', { index });
    invariant(typeof event.eventId === 'string' && event.eventId.length > 0, 'INVALID_EVENT_ID', 'Telemetry event id is required', { index });
    invariant(Number.isFinite(event.sampleTimeMs) && event.sampleTimeMs >= 0, 'INVALID_SAMPLE_TIME', 'Sample time must be finite and non-negative', { index });
    invariant(Number.isFinite(event.receivedTimeMs) && event.receivedTimeMs >= 0, 'INVALID_RECEIVED_TIME', 'Received time must be finite and non-negative', { index });
    invariant(Number.isInteger(event.sequence) && event.sequence >= 0, 'INVALID_SEQUENCE', 'Sequence must be a non-negative integer', { index });
    invariant(Number.isFinite(event.value), 'INVALID_VALUE', 'Telemetry value must be finite', { index });
    invariant(event.quality !== 'missing', 'MISSING_TELEMETRY', 'Missing telemetry cannot be replayed as a measurement', { index });
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareByPhysicalTime(a: TelemetryEvent, b: TelemetryEvent): number {
  return a.sampleTimeMs - b.sampleTimeMs
    || a.sequence - b.sequence
    || compareStrings(a.eventId, b.eventId);
}

function canonicalizeTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  validateTelemetry(input);
  const runIds = new Set(input.map((event) => event.runId));
  invariant(input.length === 0 || runIds.size === 1, 'MIXED_RUNS', 'A replay batch must contain one test run', { runIds: [...runIds] });

  const byEventId = new Map<string, EventIdGroup>();
  for (const [index, event] of input.entries()) {
    const group = byEventId.get(event.eventId) ?? { byContent: new Map<string, EventContentGroup>() };
    const fingerprint = contentFingerprint(event);
    const contentGroup = group.byContent.get(fingerprint) ?? { fingerprint, content: eventContent(event), reports: [] };
    contentGroup.reports.push({ index, event });
    group.byContent.set(fingerprint, contentGroup);
    byEventId.set(event.eventId, group);
  }

  const conflicts = [...byEventId.entries()]
    .filter(([, group]) => group.byContent.size > 1)
    .map(([eventId, group]) => {
      const variants = [...group.byContent.values()]
        .map((contentGroup) => {
          const indexes = contentGroup.reports.map((report) => report.index).sort((a, b) => a - b);
          return {
            fingerprint: contentGroup.fingerprint,
            indexes,
            receivedTimeMs: contentGroup.reports.map((report) => report.event.receivedTimeMs),
            content: contentGroup.content,
          };
        })
        .sort((a, b) => compareStrings(a.fingerprint, b.fingerprint));
      return {
        eventId,
        indexes: variants.flatMap((variant) => variant.indexes).sort((a, b) => a - b),
        variants,
      };
    })
    .sort((a, b) => compareStrings(a.eventId, b.eventId));

  if (conflicts.length > 0) {
    throw new DomainError(
      'EVENT_ID_CONFLICT',
      `Conflicting telemetry reports share eventId(s): ${conflicts.map((conflict) => conflict.eventId).join(', ')}`,
      422,
      {
        eventId: conflicts[0].eventId,
        indexes: conflicts[0].indexes,
        conflicts,
      },
    );
  }

  return [...byEventId.values()]
    .map((group) => {
      const reports = [...group.byContent.values()][0].reports;
      return reports.reduce((latest, report) => {
        if (report.event.receivedTimeMs > latest.event.receivedTimeMs
          || (report.event.receivedTimeMs === latest.event.receivedTimeMs && report.index < latest.index)) {
          return report;
        }
        return latest;
      }).event;
    })
    .sort(compareByPhysicalTime);
}

export function replayTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  return canonicalizeTelemetry(input);
}

export function indexBySampleTime(events: TelemetryEvent[]): Map<number, TelemetryEvent[]> {
  const index = new Map<number, TelemetryEvent[]>();
  for (const event of canonicalizeTelemetry(events)) {
    index.set(event.sampleTimeMs, [...(index.get(event.sampleTimeMs) ?? []), event]);
  }
  return index;
}
