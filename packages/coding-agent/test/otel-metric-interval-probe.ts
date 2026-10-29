/**
 * Metric-cadence probe, run as a subprocess by telemetry-export.test.ts for the
 * same reason as the other probes: initTelemetryExport() registers a
 * process-global MeterProvider.
 *
 * Sets OTEL_METRIC_EXPORT_INTERVAL to 200 ms, records one counter value and
 * never flushes. Exits 0 only when the loopback receiver gets a /v1/metrics
 * POST within 3 s, which the default 60 s reader interval and the 30 s periodic
 * flush cannot produce.
 */

import { initTelemetryExport, isTelemetryExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { metrics } from "@opentelemetry/api";

const received = Promise.withResolvers<void>();
const server = Bun.serve({
	port: 0,
	fetch(req) {
		if (req.method === "POST" && new URL(req.url).pathname.endsWith("/v1/metrics")) received.resolve();
		return new Response('{"partialSuccess":{}}', { status: 200, headers: { "content-type": "application/json" } });
	},
});

process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `http://localhost:${server.port}/v1/metrics`;
process.env.OTEL_METRIC_EXPORT_INTERVAL = "200";

await initTelemetryExport(true);
if (!isTelemetryExportEnabled()) {
	console.error("PROBE: provider did not register");
	await server.stop(true);
	process.exit(2);
}

metrics.getMeter("probe").createCounter("probe.ticks").add(1);

const exported = await Promise.race([received.promise.then(() => true), Bun.sleep(3_000).then(() => false)]);
await server.stop(true);
console.log(exported ? "PROBE: RECEIVED" : "PROBE: NO_EXPORT");
process.exit(exported ? 0 : 1);
