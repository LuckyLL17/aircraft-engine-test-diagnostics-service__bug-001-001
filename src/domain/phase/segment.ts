import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

type RpmPoint = { time: number; rpm: number; fuel: number };

function collectPoints(samples: CalibratedSample[]): RpmPoint[] {
  const byTime = new Map<number, RpmPoint>();
  for (const sample of samples) {
    const point = byTime.get(sample.sampleTimeMs) ?? { time: sample.sampleTimeMs, rpm: Number.NaN, fuel: Number.NaN };
    if (sample.sensor === 'rpm') point.rpm = sample.calibratedValue;
    if (sample.sensor === 'fuel-flow') point.fuel = sample.calibratedValue;
    byTime.set(sample.sampleTimeMs, point);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).filter((point) => Number.isFinite(point.rpm));
}

function phaseForSlope(slope: number, rpm: number): EnginePhaseName {
  if (rpm < 500) return 'shutdown';
  if (slope > 0.25) return 'acceleration';
  if (slope < -0.25) return 'deceleration';
  return 'steady';
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500): PhaseSegment[] {
  const points = collectPoints(samples);
  invariant(points.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');
  const segments: PhaseSegment[] = [];
  let current: { phase: EnginePhaseName; points: RpmPoint[] } = { phase: points[0].rpm < 500 ? 'idle' : 'steady', points: [points[0]] };
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const point = points[i];
    const duration = Math.max(1, point.time - previous.time);
    const phase = phaseForSlope((point.rpm - previous.rpm) / duration * 1000, point.rpm);
    const shouldSplit = phase !== current.phase && point.time - current.points[0].time >= minimumPhaseDurationMs;
    if (shouldSplit) {
      segments.push(toSegment(current.phase, current.points));
      current = { phase, points: [previous, point] };
    } else current.points.push(point);
  }
  segments.push(toSegment(current.phase, current.points));
  return mergeShortSegments(segments, minimumPhaseDurationMs);
}

function toSegment(phase: EnginePhaseName, points: RpmPoint[]): PhaseSegment {
  const finiteFuel = points.map((point) => point.fuel).filter(Number.isFinite);
  const rpms = points.map((point) => point.rpm);
  return { phase, startMs: points[0].time, endMs: points.at(-1)!.time, sampleCount: points.length, meanRpm: rpms.reduce((a, b) => a + b, 0) / rpms.length, peakRpm: Math.max(...rpms), meanFuelFlow: finiteFuel.length ? finiteFuel.reduce((a, b) => a + b, 0) / finiteFuel.length : 0 };
}

function mergeShortSegments(segments: PhaseSegment[], minimumDuration: number): PhaseSegment[] {
  if (segments.length < 2) return segments;
  const result: PhaseSegment[] = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    if (previous && segment.endMs - segment.startMs < minimumDuration) {
      const merged = { ...previous, endMs: segment.endMs, sampleCount: previous.sampleCount + segment.sampleCount, peakRpm: Math.max(previous.peakRpm, segment.peakRpm), meanRpm: (previous.meanRpm * previous.sampleCount + segment.meanRpm * segment.sampleCount) / (previous.sampleCount + segment.sampleCount), meanFuelFlow: (previous.meanFuelFlow * previous.sampleCount + segment.meanFuelFlow * segment.sampleCount) / (previous.sampleCount + segment.sampleCount) };
      result[result.length - 1] = merged;
    } else result.push(segment);
  }
  return result;
}
