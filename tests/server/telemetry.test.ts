/**
 * @fileoverview Tests for the telemetry module.
 *
 * Tests metric definitions, Express middleware, Prometheus scrape endpoint,
 * and client metrics push endpoint.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  metricsRegistry,
  metricsMiddleware,
  clientMetricsHandler,
  metricsHandler,
  httpRequestDuration,
  httpRequestsTotal,
  wsConnectionsActive,
  wsMessagesTotal,
  claudeCommandDuration,
  claudeCommandsTotal,
  claudeSessionsActive,
  webVitalLCP,
  clientWsReconnects,
} from '../../server/telemetry';

// Helper to create mock Express request/response
function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    path: '/test',
    route: null,
    body: {},
    ...overrides,
  } as any;
}

function mockRes() {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let body = '';
  const listeners: Record<string, Function[]> = {};

  const res = {
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    status(code: number) { statusCode = code; return res; },
    set(key: string, value: string) { headers[key] = value; return res; },
    json(data: unknown) { body = JSON.stringify(data); return res; },
    end(data?: string) { body = data || ''; return res; },
    on(event: string, fn: Function) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return res;
    },
    emit(event: string) {
      (listeners[event] || []).forEach(fn => fn());
    },
    getBody() { return body; },
    getHeaders() { return headers; },
  };
  return res;
}

describe('Telemetry', () => {
  beforeEach(async () => {
    // Reset all metrics between tests
    metricsRegistry.resetMetrics();
  });

  describe('metricsMiddleware', () => {
    test('records HTTP request duration and count', async () => {
      const req = mockReq({ method: 'GET', path: '/health' });
      const res = mockRes();
      let nextCalled = false;

      metricsMiddleware(req, res as any, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);

      // Simulate response finishing
      res.emit('finish');

      // Check that metrics were recorded
      const metrics = await metricsRegistry.getMetricsAsJSON();
      const durationMetric = metrics.find(m => m.name === 'http_request_duration_seconds');
      const countMetric = metrics.find(m => m.name === 'http_requests_total');

      expect(durationMetric).toBeDefined();
      expect(countMetric).toBeDefined();
    });
  });

  describe('metricsHandler (GET /metrics)', () => {
    test('returns Prometheus text format', async () => {
      const req = mockReq();
      const res = mockRes();

      await metricsHandler(req, res as any);

      const headers = res.getHeaders();
      expect(headers['Content-Type']).toContain('text/plain');
      const body = res.getBody();
      // Should contain default process metrics
      expect(body).toContain('process_cpu');
    });
  });

  describe('clientMetricsHandler (POST /metrics/client)', () => {
    test('records a valid histogram metric', () => {
      const req = mockReq({
        method: 'POST',
        body: { name: 'web_vital_lcp_seconds', value: 1.5 },
      });
      const res = mockRes();

      clientMetricsHandler(req, res as any);

      const body = JSON.parse(res.getBody());
      expect(body.status).toBe('ok');
    });

    test('records a valid counter metric', () => {
      const req = mockReq({
        method: 'POST',
        body: { name: 'client_ws_reconnects_total', value: 1 },
      });
      const res = mockRes();

      clientMetricsHandler(req, res as any);

      const body = JSON.parse(res.getBody());
      expect(body.status).toBe('ok');
    });

    test('rejects unknown metric name', () => {
      const req = mockReq({
        method: 'POST',
        body: { name: 'unknown_metric', value: 1 },
      });
      const res = mockRes();

      clientMetricsHandler(req, res as any);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.getBody());
      expect(body.error).toContain('Unknown metric');
    });

    test('rejects missing name', () => {
      const req = mockReq({
        method: 'POST',
        body: { value: 1 },
      });
      const res = mockRes();

      clientMetricsHandler(req, res as any);

      expect(res.statusCode).toBe(400);
    });

    test('rejects missing value', () => {
      const req = mockReq({
        method: 'POST',
        body: { name: 'web_vital_lcp_seconds' },
      });
      const res = mockRes();

      clientMetricsHandler(req, res as any);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('Server metrics', () => {
    test('WebSocket connection gauge increments and decrements', async () => {
      wsConnectionsActive.inc({ server: 'main' });
      wsConnectionsActive.inc({ server: 'main' });
      wsConnectionsActive.dec({ server: 'main' });

      const value = (await wsConnectionsActive.get()).values
        .find(v => v.labels.server === 'main');
      expect(value?.value).toBe(1);
    });

    test('WebSocket messages counter increments', async () => {
      wsMessagesTotal.inc({ server: 'main', direction: 'in', type: 'command' });
      wsMessagesTotal.inc({ server: 'main', direction: 'in', type: 'command' });

      const value = (await wsMessagesTotal.get()).values
        .find(v => v.labels.type === 'command' && v.labels.direction === 'in');
      expect(value?.value).toBe(2);
    });

    test('Claude command duration histogram records', async () => {
      const endTimer = claudeCommandDuration.startTimer();
      // Simulate some work
      endTimer();

      const metric = await claudeCommandDuration.get();
      const countValue = metric.values.find(v => v.metricName === 'claude_command_duration_seconds_count');
      expect(countValue?.value).toBe(1);
    });

    test('Claude commands counter tracks status', async () => {
      claudeCommandsTotal.inc({ status: 'success' });
      claudeCommandsTotal.inc({ status: 'success' });
      claudeCommandsTotal.inc({ status: 'error' });

      const values = (await claudeCommandsTotal.get()).values;
      const success = values.find(v => v.labels.status === 'success');
      const error = values.find(v => v.labels.status === 'error');
      expect(success?.value).toBe(2);
      expect(error?.value).toBe(1);
    });

    test('Claude sessions active gauge works', async () => {
      claudeSessionsActive.inc();
      claudeSessionsActive.inc();

      const metric = await claudeSessionsActive.get();
      expect(metric.values[0]?.value).toBe(2);
    });
  });
});
