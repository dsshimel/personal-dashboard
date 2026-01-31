/**
 * @fileoverview Client-side telemetry for Web Vitals and WebSocket metrics.
 *
 * Collects Core Web Vitals (LCP, CLS, INP, TTFB) via the web-vitals
 * library and pushes them to the server's /metrics/client endpoint for
 * Prometheus storage.
 */

import { onLCP, onCLS, onINP, onTTFB } from 'web-vitals';

const SERVER_URL = `${window.location.protocol}//${window.location.hostname}:4001`;

function reportMetric(name: string, value: number) {
  fetch(`${SERVER_URL}/metrics/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, value }),
  }).catch(() => {}); // Fire and forget
}

/** Initialize Web Vitals collection. Call once on app startup. */
export function initClientTelemetry() {
  onLCP((metric) => reportMetric('web_vital_lcp_seconds', metric.value / 1000));
  onCLS((metric) => reportMetric('web_vital_cls', metric.value));
  onINP((metric) => reportMetric('web_vital_inp_seconds', metric.value / 1000));
  onTTFB((metric) => reportMetric('web_vital_ttfb_seconds', metric.value / 1000));
}

/** Report a WebSocket round-trip latency measurement. */
export function reportWsLatency(latencyMs: number) {
  reportMetric('client_ws_latency_seconds', latencyMs / 1000);
}

/** Report a WebSocket reconnection event. */
export function reportWsReconnect() {
  reportMetric('client_ws_reconnects_total', 1);
}
