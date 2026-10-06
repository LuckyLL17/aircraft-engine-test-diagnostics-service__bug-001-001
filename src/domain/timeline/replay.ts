import { DomainError, invariant } from '../errors.ts';
import type { TelemetryEvent } from '../types.ts';

/**
 * 构成一次物理采样内容的字段。receivedTimeMs 只是采集节点到服务的传输元数据，
 * 同一采样的重传必然带有不同的到达时间，因此不参与内容一致性判定。
 */
const CONTENT_FIELDS = ['sampleTimeMs', 'sequence', 'sensor', 'value', 'unit', 'quality', 'channel'] as const;
type ContentField = (typeof CONTENT_FIELDS)[number];

type IndexedEvent = { index: number; event: TelemetryEvent };

function normalizedField(event: TelemetryEvent, field: ContentField): unknown {
  const value = event[field];
  return value === undefined ? null : value;
}

/** 采样内容指纹：字段顺序固定，与输入到达顺序无关。 */
function contentSignature(event: TelemetryEvent): string {
  return JSON.stringify(CONTENT_FIELDS.map((field) => normalizedField(event, field)));
}

/** 整条报文的规范化形式，仅用于完全等价副本之间的确定性裁决。 */
function fullSignature(event: TelemetryEvent): string {
  return JSON.stringify([
    event.runId,
    event.eventId,
    event.sampleTimeMs,
    event.receivedTimeMs,
    event.sequence,
    event.sensor,
    event.value,
    event.unit,
    event.quality ?? null,
    event.channel ?? null,
  ]);
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

/**
 * 按 eventId 汇聚同一物理采样的所有上报：
 * - 内容完全一致（忽略到达时间戳）的重复上报只保留一条；
 * - 同 eventId 内容不一致时拒绝整批数据，并给出冲突字段与各报文在输入中的位置；
 * - 裁决只依赖报文自身取值（最早到达者胜出），不依赖输入顺序。
 */
export function deduplicateTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  validateTelemetry(input);
  if (input.length === 0) return [];

  const runIds = new Set(input.map((event) => event.runId));
  invariant(runIds.size === 1, 'MIXED_RUNS', 'A replay batch must contain one test run', { runIds: [...runIds] });

  const groups = new Map<string, IndexedEvent[]>();
  input.forEach((event, index) => {
    const members = groups.get(event.eventId) ?? [];
    members.push({ index, event });
    groups.set(event.eventId, members);
  });

  const conflicts: Array<Record<string, unknown>> = [];
  const winners: TelemetryEvent[] = [];

  for (const eventId of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const members = groups.get(eventId)!;
    const variants = new Map<string, { event: TelemetryEvent; indices: number[] }>();
    for (const { index, event } of members) {
      const signature = contentSignature(event);
      const variant = variants.get(signature);
      if (variant) variant.indices.push(index);
      else variants.set(signature, { event, indices: [index] });
    }

    if (variants.size > 1) {
      const differingFields = CONTENT_FIELDS.filter((field) => {
        const values = new Set([...variants.values()].map(({ event }) => JSON.stringify(normalizedField(event, field))));
        return values.size > 1;
      });
      conflicts.push({
        eventId,
        differingFields,
        occurrences: [...variants.values()]
          .map(({ event, indices }) => ({
            indices: [...indices].sort((a, b) => a - b),
            sampleTimeMs: event.sampleTimeMs,
            receivedTimeMs: event.receivedTimeMs,
            sequence: event.sequence,
            sensor: event.sensor,
            channel: event.channel ?? null,
            value: event.value,
            unit: event.unit,
            quality: event.quality ?? null,
          }))
          .sort((a, b) => a.indices[0] - b.indices[0]),
      });
      continue;
    }

    // 所有副本内容一致：确定性保留“最早到达”的那份；其余字段完全相同时按规范形式裁决。
    const winner = members
      .map(({ event }) => event)
      .sort((a, b) => a.receivedTimeMs - b.receivedTimeMs || fullSignature(a).localeCompare(fullSignature(b)))[0];
    winners.push(winner);
  }

  if (conflicts.length > 0) {
    throw new DomainError(
      'TELEMETRY_EVENT_CONFLICT',
      `Conflicting reports received for ${conflicts.length} event id(s): ${conflicts.map((conflict) => conflict.eventId).join(', ')}`,
      422,
      { conflicts },
    );
  }

  return winners;
}

/**
 * 依据采样发生时间重建物理时序；同一采样时刻按确定性序号排序，
 * eventId 作为最终稳定次序，结果不受输入到达顺序影响。
 */
export function replayTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  return deduplicateTelemetry(input).sort(
    (a, b) =>
      a.sampleTimeMs - b.sampleTimeMs ||
      a.sequence - b.sequence ||
      a.eventId.localeCompare(b.eventId),
  );
}

/**
 * 采样时间索引与重放结果共用同一套去重语义：桶内保持重放后的物理时序，
 * 重复/冲突处理与 replayTelemetry 完全一致。
 */
export function indexBySampleTime(events: TelemetryEvent[]): Map<number, TelemetryEvent[]> {
  const index = new Map<number, TelemetryEvent[]>();
  for (const event of replayTelemetry(events)) {
    index.set(event.sampleTimeMs, [...(index.get(event.sampleTimeMs) ?? []), event]);
  }
  return index;
}
