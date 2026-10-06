import { DomainError, invariant } from '../errors.ts';
import type { TelemetryEvent } from '../types.ts';

function eventFingerprint(event: TelemetryEvent): string {
  return JSON.stringify([event.runId, event.eventId, event.sampleTimeMs, event.sequence, event.sensor, event.value, event.unit, event.channel ?? '']);
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

export function replayTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  validateTelemetry(input);
  const runIds = new Set(input.map((event) => event.runId));
  invariant(runIds.size === 1, 'MIXED_RUNS', 'A replay batch must contain one test run', { runIds: [...runIds] });
  const byStream = new Map<string, TelemetryEvent>();
  for (const event of [...input].sort((a, b) => a.receivedTimeMs - b.receivedTimeMs || a.sequence - b.sequence)) {
    const streamKey = `${event.eventId}:${event.sensor}:${event.channel ?? ''}`;
    const previous = byStream.get(streamKey);
    if (previous && eventFingerprint(previous) !== eventFingerprint(event)) {
      byStream.set(streamKey, event);
      continue;
    }
    if (!previous || event.receivedTimeMs >= previous.receivedTimeMs) byStream.set(streamKey, event);
  }
  const replayed = [...byStream.values()];
  return replayed.sort((a, b) => a.receivedTimeMs - b.receivedTimeMs || a.sampleTimeMs - b.sampleTimeMs || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

export function indexBySampleTime(events: TelemetryEvent[]): Map<number, TelemetryEvent[]> {
  const index = new Map<number, TelemetryEvent[]>();
  for (const event of replayTelemetry(events)) index.set(event.sampleTimeMs, [...(index.get(event.sampleTimeMs) ?? []), event]);
  return index;
}
