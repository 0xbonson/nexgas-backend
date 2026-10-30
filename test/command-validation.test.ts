import { describe, it, expect } from 'vitest';
import {
  commandSchema,
  valveModeCommandSchema,
  valveActuateCommandSchema,
  tareCommandSchema,
  calPressureCommandSchema,
  calMqCommandSchema,
  calPhCommandSchema,
} from '../src/validation/command.schema.js';

describe('Command Payload Validation', () => {
  it('validates valve mode commands (auto / manual)', () => {
    expect(valveModeCommandSchema.safeParse({ mode: 'auto' }).success).toBe(true);
    expect(valveModeCommandSchema.safeParse({ mode: 'manual' }).success).toBe(true);
    expect(valveModeCommandSchema.safeParse({ mode: 'invalid' }).success).toBe(false);
  });

  it('validates valve actuation commands (open / close)', () => {
    expect(valveActuateCommandSchema.safeParse({ valve: 'open' }).success).toBe(true);
    expect(valveActuateCommandSchema.safeParse({ valve: 'close' }).success).toBe(true);
    expect(valveActuateCommandSchema.safeParse({ valve: 'toggle' }).success).toBe(false);
  });

  it('validates tare command', () => {
    expect(tareCommandSchema.safeParse({ tare: true }).success).toBe(true);
    expect(tareCommandSchema.safeParse({ tare: false }).success).toBe(false);
  });

  it('validates calibration pressure command', () => {
    expect(
      calPressureCommandSchema.safeParse({
        cal_pressure_point: { sensor: 'digester', kpa: 2.5 },
      }).success,
    ).toBe(true);

    expect(
      calPressureCommandSchema.safeParse({
        cal_pressure_point: { sensor: 'collector', kpa: 1.0 },
      }).success,
    ).toBe(true);

    expect(
      calPressureCommandSchema.safeParse({
        cal_pressure_point: { sensor: 'unknown', kpa: 1.0 },
      }).success,
    ).toBe(false);
  });

  it('validates calibration MQ command', () => {
    expect(
      calMqCommandSchema.safeParse({
        cal_mq: { gas: 'h2s', ref_ppm: 10.0 },
      }).success,
    ).toBe(true);

    expect(
      calMqCommandSchema.safeParse({
        cal_mq: { gas: 'ch4', ref_ppm: 5000.0 },
      }).success,
    ).toBe(true);

    expect(
      calMqCommandSchema.safeParse({
        cal_mq: { gas: 'leak', ref_ppm: 0 },
      }).success,
    ).toBe(true);

    expect(
      calMqCommandSchema.safeParse({
        cal_mq: { gas: 'other', ref_ppm: 0 },
      }).success,
    ).toBe(false);
  });

  it('validates calibration pH command with bounds [0, 14]', () => {
    expect(
      calPhCommandSchema.safeParse({
        cal_ph: { ph: 6.86 },
      }).success,
    ).toBe(true);

    expect(
      calPhCommandSchema.safeParse({
        cal_ph: { ph: 4.01 },
      }).success,
    ).toBe(true);

    expect(
      calPhCommandSchema.safeParse({
        cal_ph: { ph: -1.0 },
      }).success,
    ).toBe(false);

    expect(
      calPhCommandSchema.safeParse({
        cal_ph: { ph: 15.0 },
      }).success,
    ).toBe(false);
  });

  it('validates any supported command using commandSchema union', () => {
    expect(commandSchema.safeParse({ mode: 'manual' }).success).toBe(true);
    expect(commandSchema.safeParse({ valve: 'open' }).success).toBe(true);
    expect(commandSchema.safeParse({ tare: true }).success).toBe(true);
    expect(commandSchema.safeParse({ unknownCommand: true }).success).toBe(false);
  });
});