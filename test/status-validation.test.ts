import { describe, it, expect } from 'vitest';
import {
  parseStatusPayload,
  normalizeDeviceStatus,
} from '../src/validation/status.schema.js';

describe('Status Payload Validation & Normalization', () => {
  it('parses bare string status payloads ("online" and "offline")', () => {
    expect(parseStatusPayload('online')).toEqual({ status: 'online' });
    expect(parseStatusPayload('offline')).toEqual({ status: 'offline' });
    expect(parseStatusPayload('  ONLINE  ')).toEqual({ status: 'online' });
    expect(parseStatusPayload('  OFFLINE \n')).toEqual({ status: 'offline' });
  });

  it('parses JSON string status payloads', () => {
    expect(parseStatusPayload('{"status": "online"}')).toEqual({ status: 'online' });
    expect(parseStatusPayload('{"status": "offline"}')).toEqual({ status: 'offline' });
  });

  it('parses JSON object status payloads', () => {
    expect(parseStatusPayload({ status: 'online' })).toEqual({ status: 'online' });
  });

  it('returns null for invalid status values', () => {
    expect(parseStatusPayload('disconnected')).toBeNull();
    expect(parseStatusPayload('unknown')).toBeNull();
    expect(parseStatusPayload('')).toBeNull();
    expect(parseStatusPayload(123)).toBeNull();
    expect(parseStatusPayload({ status: 'invalid' })).toBeNull();
  });

  it('normalizes device status with receivedAt', () => {
    const receivedAt = new Date('2026-10-30T10:30:00.000Z');
    const normalized = normalizeDeviceStatus('nexgas-001', { status: 'online' }, receivedAt);

    expect(normalized.deviceId).toBe('nexgas-001');
    expect(normalized.status).toBe('online');
    expect(normalized.receivedAt).toBe('2026-10-30T10:30:00.000Z');
  });
});