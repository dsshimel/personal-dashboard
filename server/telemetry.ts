/**
 * @fileoverview Server-side telemetry using prom-client for Prometheus metrics.
 *
 * Defines all server and client-pushed metrics, Express middleware for HTTP
 * request instrumentation, and handlers for the /metrics endpoints.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

// Dedicated registry (avoids polluting the global default)
export const metricsRegistry = new Registry();

// Collect default process metrics (CPU, memory, event loop lag, GC, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ─── HTTP Metrics ────────────────────────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

// ─── WebSocket Metrics ───────────────────────────────────────────────────────

export const wsConnectionsActive = new Gauge({
  name: 'ws_connections_active',
  help: 'Number of active WebSocket connections',
  labelNames: ['server'] as const,
  registers: [metricsRegistry],
});

export const wsMessagesTotal = new Counter({
  name: 'ws_messages_total',
  help: 'Total WebSocket messages sent and received',
  labelNames: ['server', 'direction', 'type'] as const,
  registers: [metricsRegistry],
});

export const wsMessageDuration = new Histogram({
  name: 'ws_message_processing_seconds',
  help: 'Time to process a WebSocket message',
  labelNames: ['server', 'type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 60, 300],
  registers: [metricsRegistry],
});

// ─── Claude CLI Metrics ──────────────────────────────────────────────────────

export const claudeCommandDuration = new Histogram({
  name: 'claude_command_duration_seconds',
  help: 'Duration of Claude CLI command execution',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

export const claudeCommandsTotal = new Counter({
  name: 'claude_commands_total',
  help: 'Total Claude CLI commands executed',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const claudeSessionsActive = new Gauge({
  name: 'claude_sessions_active',
  help: 'Number of active Claude sessions',
  registers: [metricsRegistry],
});

// ─── Client-Pushed Metrics (Web Vitals + WS) ────────────────────────────────

export const webVitalLCP = new Histogram({
  name: 'web_vital_lcp_seconds',
  help: 'Largest Contentful Paint in seconds',
  buckets: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10],
  registers: [metricsRegistry],
});

export const webVitalCLS = new Histogram({
  name: 'web_vital_cls',
  help: 'Cumulative Layout Shift score',
  buckets: [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

export const webVitalINP = new Histogram({
  name: 'web_vital_inp_seconds',
  help: 'Interaction to Next Paint in seconds',
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1],
  registers: [metricsRegistry],
});

export const webVitalTTFB = new Histogram({
  name: 'web_vital_ttfb_seconds',
  help: 'Time to First Byte in seconds',
  buckets: [0.1, 0.25, 0.5, 0.8, 1, 1.5, 2, 5],
  registers: [metricsRegistry],
});

export const clientWsLatency = new Histogram({
  name: 'client_ws_latency_seconds',
  help: 'Client-measured WebSocket round-trip latency',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
  registers: [metricsRegistry],
});

export const clientWsReconnects = new Counter({
  name: 'client_ws_reconnects_total',
  help: 'Total WebSocket reconnection attempts from client',
  registers: [metricsRegistry],
});

// ─── Metric lookup for client push endpoint ──────────────────────────────────

const clientMetricMap: Record<string, Histogram | Counter> = {
  'web_vital_lcp_seconds': webVitalLCP,
  'web_vital_cls': webVitalCLS,
  'web_vital_inp_seconds': webVitalINP,
  'web_vital_ttfb_seconds': webVitalTTFB,
  'client_ws_latency_seconds': clientWsLatency,
  'client_ws_reconnects_total': clientWsReconnects,
};

// ─── Express Middleware ──────────────────────────────────────────────────────

/** Records HTTP request duration and count for every request. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationS = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.observe(labels, durationS);
    httpRequestsTotal.inc(labels);
  });
  next();
}

/** Handler for GET /metrics — Prometheus scrape endpoint. */
export async function metricsHandler(_req: Request, res: Response) {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
}

/** Handler for POST /metrics/client — receives metrics pushed from the browser. */
export function clientMetricsHandler(req: Request, res: Response) {
  const { name, value } = req.body;
  if (typeof name !== 'string' || typeof value !== 'number') {
    res.status(400).json({ error: 'name (string) and value (number) required' });
    return;
  }
  const metric = clientMetricMap[name];
  if (!metric) {
    res.status(400).json({ error: `Unknown metric: ${name}` });
    return;
  }
  if ('observe' in metric) {
    metric.observe(value);
  } else {
    metric.inc(value);
  }
  res.json({ status: 'ok' });
}
