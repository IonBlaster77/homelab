// Prometheus instant queries (the HTTP API). PROM_URL defaults to the
// in-cluster Service; for local runs use a port-forward.
const PROM = process.env.PROM_URL ?? "http://monitoring-kube-prometheus-prometheus.monitoring.svc:9090";

export interface Sample {
  metric: Record<string, string>;
  value: [number, string];
}

export async function query(expr: string): Promise<Sample[]> {
  const url = new URL(PROM + "/api/v1/query");
  url.searchParams.set("query", expr);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Prometheus query failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { status: string; data: { result: Sample[] }; error?: string };
  if (body.status !== "success") throw new Error(`Prometheus query failed: ${body.error}`);
  return body.data.result;
}

/** Trivy sometimes sends the tag as a full reference (docker.io/x/y:1.2.3). */
export const cleanTag = (tag: string) => tag.slice(tag.lastIndexOf(":") + 1);

/**
 * Image tags with a newer same-line tag in their registry, from
 * image-update-exporter (kubernetes/platform/observability/monitoring).
 * Keys are `registry/repository:tag`.
 */
export async function imagesWithUpdate(): Promise<Set<string>> {
  const rows = await query("image_update_available == 1");
  return new Set(
    rows.map((r) => `${r.metric.image_registry}/${r.metric.image_repository}:${cleanTag(r.metric.image_tag ?? "")}`),
  );
}
