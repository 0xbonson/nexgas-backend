import { describe, it, expect } from 'vitest';
import {
  rawTelemetrySchema,
  normalizeTelemetry,
} from '../src/validation/telemetry.schema.js';
import { RawTelemetryPayload } from '../src/types/index.js';

describe('Telemetry Payload Validation & Normalization', () => {
  const sampleValidRaw: RawTelemetryPayload = {
    ts: 1730000000,
    uptimeMs: 125000,
    h2sBefore: -1, // Hardware reality: only 1 sensor installed
    h2sAfter: 12.5,
    ch4: 650.0,
    leak: 45.2,
    pressureDigester: 4.8,
    pressureCollector: 2.1,
    temperature: 36.5,
    humidity: 82.0,
    gasLineTemperature: 28.1,
    gasLineHumidity: 65.4,
    ph: 7.2,
    flow: 1.5,
    gasSinceStartL: 24.0,
    sensorsReady: true,
    rssi: -65,
  };

  it('validates a conformant raw telemetry payload', () => {
    const result = rawTelemetrySchema.safeParse(sampleValidRaw);
    expect(result.success).toBe(true);
  });

  it('rejects payloads missing required fields or having invalid types', () => {
    const invalid = { ...sampleValidRaw, temperature: 'not-a-number' };
    const result = rawTelemetrySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('normalizes -1 (unavailable sensor) to null in internal representation without altering raw payload', () => {
    const receivedAt = new Date('2026-10-30T10:00:00Z');
    const normalized = normalizeTelemetry('nexgas-001', sampleValidRaw, receivedAt);

    // h2sBefore is -1 -> must be normalized to null
    expect(normalized.h2sBefore).toBeNull();
    // Raw payload preserves original -1
    expect(normalized.raw.h2sBefore).toBe(-1);

    // Valid reading is preserved
    expect(normalized.h2sAfter).toBe(12.5);
    expect(normalized.raw.h2sAfter).toBe(12.5);
  });

  it('normalizes -1 for uncalibrated pressures, sensors, and pH to null', () => {
    const rawWithUncalibrated: RawTelemetryPayload = {
      ...sampleValidRaw,
      pressureDigester: -1.0,
      pressureCollector: -1.0,
      ph: -1.0,
      ch4: -1.0,
    };

    const normalized = normalizeTelemetry('nexgas-001', rawWithUncalibrated);

    expect(normalized.pressureDigesterKpa).toBeNull();
    expect(normalized.pressureCollectorKpa).toBeNull();
    expect(normalized.ph).toBeNull();
    expect(normalized.ch4Estimate).toBeNull();
  });

  it('handles ts = 0 as unavailable device timestamp (null) while capturing server receive timestamp', () => {
    const rawWithNoNtp: RawTelemetryPayload = {
      ...sampleValidRaw,
      ts: 0, // ESP32 was offline at boot, NTP unsynced
    };

    const receivedAt = new Date('2026-10-30T12:00:00.000Z');
    const normalized = normalizeTelemetry('nexgas-001', rawWithNoNtp, receivedAt);

    expect(normalized.deviceTimestamp).toBeNull();
    expect(normalized.rawTimestamp).toBe(0);
    expect(normalized.receivedAt).toBe('2026-10-30T12:00:00.000Z');
  });

  it('converts valid epoch seconds to ISO 8601 deviceTimestamp', () => {
    const normalized = normalizeTelemetry('nexgas-001', sampleValidRaw);
    expect(normalized.deviceTimestamp).toBe(new Date(1730000000 * 1000).toISOString());
  });

  it('preserves field labels as estimates (ch4Estimate, flowEstimateLpm)', () => {
    const normalized = normalizeTelemetry('nexgas-001', sampleValidRaw);
    expect(normalized.ch4Estimate).toBe(650.0);
    expect(normalized.flowEstimateLpm).toBe(1.5);
    expect(normalized.gasSinceStartTotalL).toBe(24.0);
  });
});