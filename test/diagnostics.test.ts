import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseVibration } from '../src/domain/vibration/fuse.ts';
import { estimateRemainingLife } from '../src/domain/life/estimate.ts';
import { evaluatePerformance } from '../src/domain/performance/evaluate.ts';
import { indexBySampleTime, replayTelemetry } from '../src/domain/timeline/replay.ts';
import { DomainError } from '../src/domain/errors.ts';

test('replay is deterministic and removes duplicate event ids', () => {
  const events = [
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
    { runId: 'run-1', eventId: 'a', sampleTimeMs: 1, receivedTimeMs: 3, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
  ] as any;
  assert.deepEqual(replayTelemetry(events).map((item) => item.eventId), ['a', 'b']);
});

test('replay rebuilds physical time order regardless of arrival order', () => {
  const first = { runId: 'run-1', eventId: 'sample-1', sampleTimeMs: 100, receivedTimeMs: 20, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' };
  const second = { runId: 'run-1', eventId: 'sample-2', sampleTimeMs: 100, receivedTimeMs: 10, sequence: 2, sensor: 'rpm', value: 810, unit: 'rpm' };
  const third = { runId: 'run-1', eventId: 'sample-3', sampleTimeMs: 120, receivedTimeMs: 40, sequence: 1, sensor: 'rpm', value: 820, unit: 'rpm' };

  assert.deepEqual(replayTelemetry([third, second, first]).map((event) => event.eventId), ['sample-1', 'sample-2', 'sample-3']);
});

test('sequence breaks ties at the same sample time', () => {
  const laterSequence = { runId: 'run-1', eventId: 'later-sequence', sampleTimeMs: 100, receivedTimeMs: 10, sequence: 2, sensor: 'rpm', value: 810, unit: 'rpm' };
  const earlierSequence = { runId: 'run-1', eventId: 'earlier-sequence', sampleTimeMs: 100, receivedTimeMs: 90, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' };

  assert.deepEqual(replayTelemetry([laterSequence, earlierSequence]).map((event) => event.eventId), ['earlier-sequence', 'later-sequence']);
});

test('replay collapses duplicate reports while retaining one deterministic event', () => {
  const original = { runId: 'run-1', eventId: 'duplicate', sampleTimeMs: 100, receivedTimeMs: 30, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm', quality: 'good', channel: 'A' };
  const delayedCopy = { ...original, receivedTimeMs: 90 };
  const repeatedCopy = { ...original, receivedTimeMs: 30 };

  const replayed = replayTelemetry([delayedCopy, original, repeatedCopy]);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].receivedTimeMs, 90);
});

test('replay rejects conflicting reports for the same event id with input locations', () => {
  const events = [
    { runId: 'run-1', eventId: 'conflict', sampleTimeMs: 100, receivedTimeMs: 20, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 'other', sampleTimeMs: 90, receivedTimeMs: 30, sequence: 0, sensor: 'rpm', value: 700, unit: 'rpm' },
    { runId: 'run-1', eventId: 'conflict', sampleTimeMs: 100, receivedTimeMs: 40, sequence: 1, sensor: 'rpm', value: 850, unit: 'rpm' },
  ] as any;

  assert.throws(
    () => replayTelemetry([...events]),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'EVENT_ID_CONFLICT');
      assert.equal(error.details.eventId, 'conflict');
      assert.deepEqual(error.details.indexes, [0, 2]);
      assert.equal((error.details.conflicts as unknown[]).length, 1);
      assert.throws(() => indexBySampleTime([...events]), DomainError);
      return true;
    },
  );
});

test('sample-time index uses replay deduplication and ordering semantics', () => {
  const events = [
    { runId: 'run-1', eventId: 't2-late', sampleTimeMs: 200, receivedTimeMs: 500, sequence: 1, sensor: 'rpm', value: 900, unit: 'rpm' },
    { runId: 'run-1', eventId: 't1-duplicate', sampleTimeMs: 100, receivedTimeMs: 120, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 't1-duplicate', sampleTimeMs: 100, receivedTimeMs: 180, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 't2-late', sampleTimeMs: 200, receivedTimeMs: 510, sequence: 1, sensor: 'rpm', value: 900, unit: 'rpm' },
  ];

  const replayFromArrivalOrder = replayTelemetry(events);
  const replayFromReverse = replayTelemetry([...events].reverse());
  const indexFromArrivalOrder = indexBySampleTime(events);
  const indexFromReverse = indexBySampleTime([...events].reverse());

  assert.deepEqual(replayFromArrivalOrder, replayFromReverse);
  assert.deepEqual([...indexFromArrivalOrder.keys()], [100, 200]);
  assert.deepEqual([...indexFromReverse.keys()], [100, 200]);
  assert.deepEqual([...indexFromArrivalOrder.values()].flat(), replayFromArrivalOrder);
  assert.deepEqual([...indexFromReverse.values()].flat(), replayFromReverse);
});

test('performance produces physical normalized indicators', () => {
  const result = evaluatePerformance({ rpm: 9_000, fuelFlowKgPerSecond: 2, compressorOutletPressureKpa: 900, turbineInletTemperatureK: 1_000, ambientPressureKpa: 101.3, ambientTemperatureK: 288, inletPressureKpa: 100, referenceRpm: 10_000, referenceTemperatureK: 288, referencePressureKpa: 101.3 });
  assert.ok(result.pressureRatio > 1);
  assert.ok(result.compressorEfficiency >= 0 && result.compressorEfficiency <= 1);
});

test('vibration evidence is grouped by correlated source', () => {
  const result = diagnoseVibration([
    { evidenceId: 'a', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 0, windowEndMs: 100, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'b', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 20, windowEndMs: 80, feature: 'broadband', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'c', sensorId: 's2', sourceGroup: 'g2', windowStartMs: 200, windowEndMs: 300, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 3, amplitude: 2 },
  ]);
  assert.equal(result[0].evidenceIds.length, 2);
});

test('life estimate is reproducible for a fixed seed', () => {
  const input = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 100, seed: 42, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]] };
  assert.deepEqual(estimateRemainingLife(input), estimateRemainingLife(input));
});
