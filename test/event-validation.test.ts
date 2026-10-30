import { describe, it, expect } from 'vitest';
import {
  rawEventSchema,
  normalizeDeviceEvent,
} from '../src/validation/event.schema.js';
import { DeviceEventPayload } from '../src/types/index.js';

describe('Event Payload Validation & Normalization', () => {
  const sampleEvent: DeviceEventPayload = {
    ts: 1730000050,
    uptimeMs: 60000,
    type: 'valve_closed_leak',
    severity: 'bahaya',
    message: 'Solenoid ditutup paksa: metana di udara sekitar berbahaya',
  };

  it('validates a conformant event payload', () => {
    expect(rawEventSchema.safeParse(sampleEvent).success).toBe(true);
  });

  it('rejects events missing type or message', () => {
    expect(rawEventSchema.safeParse({ ...sampleEvent, type: '' }).success).toBe(false);
    expect(rawEventSchema.safeParse({ ...sampleEvent, message: 123 }).success).toBe(false);
  });

  it('normalizes device event and maps severity', () => {
    const receivedAt = new Date('2026-10-30T10:45:00.000Z');
    const normalized = normalizeDeviceEvent('nexgas-001', sampleEvent, receivedAt);

    expect(normalized.deviceId).toBe('nexgas-001');
    expect(normalized.type).toBe('valve_closed_leak');
    expect(normalized.severity).toBe('bahaya');
    expect(normalized.message).toBe('Solenoid ditutup paksa: metana di udara sekitar berbahaya');
    expect(normalized.receivedAt).toBe('2026-10-30T10:45:00.000Z');
    expect(normalized.deviceTimestamp).toBe(new Date(1730000050 * 1000).toISOString());
    expect(normalized.raw).toEqual(sampleEvent);
  });

  it('defaults unknown severity to "info"', () => {
    const eventWithUnknownSeverity: DeviceEventPayload = {
      ...sampleEvent,
      severity: 'custom_severity' as any,
    };
    const normalized = normalizeDeviceEvent('nexgas-001', eventWithUnknownSeverity);
    expect(normalized.severity).toBe('info');
  });

  it('normalizes ts = 0 to null deviceTimestamp', () => {
    const eventNoNtp: DeviceEventPayload = {
      ...sampleEvent,
      ts: 0,
    };
    const normalized = normalizeDeviceEvent('nexgas-001', eventNoNtp);
    expect(normalized.deviceTimestamp).toBeNull();
  });
});