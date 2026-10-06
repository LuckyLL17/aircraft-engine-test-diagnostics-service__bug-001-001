import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTelemetry, indexBySampleTime, deduplicateTelemetry } from '../src/domain/timeline/replay.ts';
import { DomainError } from '../src/domain/errors.ts';
import type { TelemetryEvent } from '../src/domain/types.ts';

function event(partial: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'eventId' | 'sampleTimeMs' | 'receivedTimeMs' | 'sequence'>): TelemetryEvent {
  return { runId: 'run-1', sensor: 'rpm', value: 800, unit: 'rpm', ...partial };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('replay rebuilds physical order from sample time and sequence regardless of arrival', () => {
  const events = [
    event({ eventId: 'late', sampleTimeMs: 100, receivedTimeMs: 900, sequence: 1, value: 810 }),
    event({ eventId: 'early-arrival', sampleTimeMs: 300, receivedTimeMs: 10, sequence: 3, value: 830 }),
    event({ eventId: 'mid', sampleTimeMs: 200, receivedTimeMs: 500, sequence: 2, value: 820 }),
  ];
  const replayed = replayTelemetry(events);
  assert.deepEqual(replayed.map((item) => item.eventId), ['late', 'mid', 'early-arrival']);
  assert.deepEqual(replayed.map((item) => item.sampleTimeMs), [100, 200, 300]);
});

test('sequence is the deterministic tie breaker at the same sample time', () => {
  const events = [
    event({ eventId: 'c', sampleTimeMs: 100, receivedTimeMs: 30, sequence: 3 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 10, sequence: 1 }),
    event({ eventId: 'b', sampleTimeMs: 100, receivedTimeMs: 20, sequence: 2 }),
  ];
  assert.deepEqual(replayTelemetry(events).map((item) => item.eventId), ['a', 'b', 'c']);
});

test('identical eventId reports collapse to one even when received timestamps differ', () => {
  const clean = [
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 500, sequence: 1, value: 800 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 50, sequence: 1, value: 800 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 720, sequence: 1, value: 800 }),
  ];
  const replayed = replayTelemetry(clean);
  assert.equal(replayed.length, 1);
  // Earliest successful delivery wins deterministically.
  assert.equal(replayed[0].receivedTimeMs, 50);
});

test('conflicting same-id events are rejected with field and location details', () => {
  const events = [
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 10, sequence: 1, value: 800 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 20, sequence: 1, value: 800 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 30, sequence: 1, value: 950 }),
  ];
  try {
    replayTelemetry(events);
    assert.fail('expected conflict rejection');
  } catch (error) {
    assert.ok(error instanceof DomainError);
    assert.equal((error as DomainError).code, 'TELEMETRY_EVENT_CONFLICT');
    const conflicts = (error as DomainError).details.conflicts as Array<Record<string, unknown>>;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].eventId, 'a');
    assert.deepEqual(conflicts[0].differingFields, ['value']);
    const occurrences = conflicts[0].occurrences as Array<{ indices: number[]; value: number }>;
    assert.deepEqual(occurrences.map((occurrence) => occurrence.indices), [[0, 1], [2]]);
    assert.deepEqual(occurrences.map((occurrence) => occurrence.value), [800, 950]);
  }
});

test('replay output is invariant under input arrival permutation', () => {
  const events = [
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 300, sequence: 1, value: 800 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 12, sequence: 1, value: 800 }),
    event({ eventId: 'b', sampleTimeMs: 50, receivedTimeMs: 900, sequence: 0, value: 700 }),
    event({ eventId: 'c', sampleTimeMs: 100, receivedTimeMs: 5, sequence: 2, value: 810 }),
  ];
  const baseline = replayTelemetry(events);
  for (let seed = 1; seed <= 8; seed += 1) {
    assert.deepEqual(replayTelemetry(shuffle(events, seed)), baseline);
  }
  assert.deepEqual(baseline.map((item) => item.eventId), ['b', 'a', 'c']);
});

test('sample time index shares replay dedup semantics and physical ordering', () => {
  const events = [
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 40, sequence: 2, value: 820 }),
    event({ eventId: 'a', sampleTimeMs: 100, receivedTimeMs: 99, sequence: 2, value: 820 }),
    event({ eventId: 'b', sampleTimeMs: 100, receivedTimeMs: 10, sequence: 1, value: 800 }),
    event({ eventId: 'c', sampleTimeMs: 50, receivedTimeMs: 80, sequence: 0, value: 700 }),
  ];
  const index = indexBySampleTime(events);
  assert.deepEqual([...index.keys()], [50, 100]);
  assert.deepEqual(index.get(100)!.map((item) => item.eventId), ['b', 'a']);

  const conflicting = [...events, event({ eventId: 'b', sampleTimeMs: 100, receivedTimeMs: 11, sequence: 1, value: 799 })];
  assert.throws(() => indexBySampleTime(conflicting), (error: unknown) => error instanceof DomainError && (error as DomainError).code === 'TELEMETRY_EVENT_CONFLICT');
});

test('deduplicate rejects batches spanning multiple runs', () => {
  const events = [
    event({ eventId: 'a', sampleTimeMs: 1, receivedTimeMs: 1, sequence: 0, runId: 'run-1' }),
    event({ eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 2, sequence: 1, runId: 'run-2' }),
  ];
  assert.throws(() => deduplicateTelemetry(events), (error: unknown) => error instanceof DomainError && (error as DomainError).code === 'MIXED_RUNS');
});

test('empty replay is valid and yields an empty index', () => {
  assert.deepEqual(replayTelemetry([]), []);
  assert.equal(indexBySampleTime([]).size, 0);
});
