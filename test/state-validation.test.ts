import { describe, it, expect } from 'vitest';
import {
  rawStateSchema,
  normalizeDeviceState,
} from '../src/validation/state.schema.js';
import { DeviceStatePayload } from '../src/types/index.js';

describe('State Payload Validation & Normalization', () => {
  const sampleValidState: DeviceStatePayload = {
    valveOpen: false,
    valveMode: 'auto',
    filterWarning: false,
    leakWarning: false,
    filterHealth: 95,
    pressureCalibrated: true,
    phCalibrated: true,
    sensorsReady: true,
    buffered: 0,
    uptimeMs: 3600000,
    firmware: '1.0.0',
  };

  it('validates a conformant state payload', () => {
    const result = rawStateSchema.safeParse(sampleValidState);
    expect(result.success).toBe(true);
  });

  it('rejects invalid valveMode values', () => {
    const invalid = { ...sampleValidState, valveMode: 'unknown' };
    const result = rawStateSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects filterHealth outside 0-100 range', () => {
    expect(rawStateSchema.safeParse({ ...sampleValidState, filterHealth: -5 }).success).toBe(false);
    expect(rawStateSchema.safeParse({ ...sampleValidState, filterHealth: 105 }).success).toBe(false);
  });

  it('normalizes state with deviceId and receivedAt', () => {
    const receivedAt = new Date('2026-10-30T10:15:00.000Z');
    const normalized = normalizeDeviceState('nexgas-001', sampleValidState, receivedAt);

    expect(normalized.deviceId).toBe('nexgas-001');
    expect(normalized.receivedAt).toBe('2026-10-30T10:15:00.000Z');
    expect(normalized.valveOpen).toBe(false);
    expect(normalized.valveMode).toBe('auto');
    expect(normalized.firmware).toBe('1.0.0');
  });
});