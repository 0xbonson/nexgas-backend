import { describe, it, expect, vi } from 'vitest';
import { createLogger, redactSensitive } from '../src/utils/logger.js';

describe('Logger & Secret Redaction', () => {
  it('redacts sensitive fields like passwords, tokens, and secrets from objects', () => {
    const input = {
      username: 'nexgas-admin',
      password: 'super-secret-password-123',
      nested: {
        token: 'jwt.token.here',
        MQTT_PASSWORD: 'broker-password',
        safeValue: 42,
      },
      apiKey: 'api-key-999',
    };

    const redacted = redactSensitive(input) as any;

    expect(redacted.username).toBe('nexgas-admin');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.nested.token).toBe('[REDACTED]');
    expect(redacted.nested.MQTT_PASSWORD).toBe('[REDACTED]');
    expect(redacted.nested.safeValue).toBe(42);
    expect(redacted.apiKey).toBe('[REDACTED]');
  });

  it('redacts credentials in URL strings if present', () => {
    const urlString = 'mqtts://user:secretpass123@my-cluster.hivemq.cloud:8883';
    const redacted = redactSensitive(urlString);
    expect(redacted).not.toContain('secretpass123');
    expect(redacted).toContain('user:[REDACTED]@my-cluster.hivemq.cloud:8883');
  });

  it('formats structured log output without leaking secrets', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger({ level: 'info' });

    logger.info('Connected to broker', {
      host: 'cluster.hivemq.cloud',
      password: 'secret_value',
    });

    expect(logSpy).toHaveBeenCalled();
    const loggedOutput = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedOutput);

    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Connected to broker');
    expect(parsed.data.password).toBe('[REDACTED]');
    expect(parsed.data.host).toBe('cluster.hivemq.cloud');

    logSpy.mockRestore();
  });

  it('respects log levels', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger({ level: 'warn' });

    logger.debug('This is debug');
    logger.info('This is info');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    logger.warn('This is a warning');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});