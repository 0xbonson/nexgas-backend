import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app.js';
import { Server } from 'http';

describe('Express 5 App Scaffold & Health Endpoints', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('GET /health returns 200 OK with uptime and status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.mqttConnected).toBe(false);
  });

  it('GET /health/ready returns 200 with readiness details', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.ready).toBe(true);
    expect(body.service).toBe('nexgas-backend');
    expect(Array.isArray(body.subscribedTopics)).toBe(true);
  });

  it('GET /api/config returns sanitized configuration without exposing passwords', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.PORT).toBeDefined();
    // Passwords must be redacted
    if (body.MQTT_PASSWORD) {
      expect(body.MQTT_PASSWORD).toBe('[REDACTED]');
    }
  });
});