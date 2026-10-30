import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('Config Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads valid default configurations when optional values are omitted', () => {
    delete process.env.PORT;
    delete process.env.MQTT_PORT;
    delete process.env.LOG_LEVEL;

    const config = loadConfig();
    expect(config.PORT).toBe(5001);
    expect(config.NODE_ENV).toBe('test');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MQTT_PORT).toBe(8883);
    expect(config.MQTT_CLIENT_ID_PREFIX).toBe('nexgas-backend');
    expect(config.DEFAULT_DEVICE_ID).toBe('nexgas-001');
    expect(config.MQTT_RECONNECT_PERIOD_MS).toBe(5000);
    expect(config.MQTT_CONNECT_TIMEOUT_MS).toBe(10000);
  });

  it('parses custom environment variables properly', () => {
    process.env.PORT = '8080';
    process.env.MQTT_HOST = 'custom.hivemq.cloud';
    process.env.MQTT_PORT = '8884';
    process.env.MQTT_USERNAME = 'device_user';
    process.env.MQTT_PASSWORD = 'device_pass';
    process.env.LOG_LEVEL = 'debug';

    const config = loadConfig();
    expect(config.PORT).toBe(8080);
    expect(config.MQTT_HOST).toBe('custom.hivemq.cloud');
    expect(config.MQTT_PORT).toBe(8884);
    expect(config.MQTT_USERNAME).toBe('device_user');
    expect(config.MQTT_PASSWORD).toBe('device_pass');
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('throws or handles invalid port numbers gracefully', () => {
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).toThrow();
  });
});