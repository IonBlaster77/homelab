// Minimal Kubernetes API client: list calls only, no dependencies.
//
// In the cluster it uses the pod's ServiceAccount token (re-read on every call,
// because the kubelet rotates it) and the API server's CA, which Node trusts
// through NODE_EXTRA_CA_CERTS (set in the Deployment). For local runs, point
// KUBE_API at `kubectl proxy` (http://127.0.0.1:8001); no token file is needed.
import { readFile } from "node:fs/promises";

const API = process.env.KUBE_API ?? "https://kubernetes.default.svc";
const TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  ownerReferences?: { kind: string; name: string; controller?: boolean }[];
}

export interface Vulnerability {
  vulnerabilityID: string;
  resource: string;
  installedVersion?: string;
  fixedVersion?: string;
  severity: string;
  title?: string;
  score?: number;
  primaryLink?: string;
  links?: string[];
  packagePURL?: string;
  publishedDate?: string;
  lastModifiedDate?: string;
  target?: string;
}

export interface VulnerabilityReport {
  metadata: ObjectMeta;
  report: {
    registry?: { server?: string };
    artifact: { repository: string; tag?: string; digest?: string };
    os?: { family?: string; name?: string };
    scanner?: Record<string, unknown>;
    updateTimestamp?: string;
    vulnerabilities?: Vulnerability[] | null;
  };
}

export interface ReplicaSet {
  metadata: ObjectMeta;
  spec?: { replicas?: number };
}

export interface PolicyReportResult {
  policy: string;
  rule?: string;
  /** pass | fail | warn | error | skip */
  result: string;
  message?: string;
  category?: string;
  severity?: string;
  source?: string;
}

/** wgpolicyk8s.io PolicyReport / ClusterPolicyReport: one per checked object (`scope`). */
export interface PolicyReport {
  metadata: ObjectMeta;
  scope?: { apiVersion?: string; kind: string; name: string; namespace?: string; uid?: string };
  results?: PolicyReportResult[] | null;
}

/** Pods and Jobs are only listed for their metadata (owners), see listMetadata. */
export interface MetadataOnly {
  metadata: ObjectMeta;
}

export interface Service {
  metadata: ObjectMeta;
  spec?: { type?: string; selector?: Record<string, string> };
}

export interface HTTPRoute {
  metadata: ObjectMeta;
  spec?: {
    parentRefs?: { name: string; namespace?: string; kind?: string }[];
    hostnames?: string[];
    rules?: { backendRefs?: { name: string; namespace?: string; kind?: string; group?: string }[] }[];
  };
}

export interface ConfigMap {
  metadata: ObjectMeta;
  data?: Record<string, string>;
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    return { Authorization: `Bearer ${t}` };
  } catch {
    return {}; // local run through kubectl proxy
  }
}

/** GET a list endpoint, following `continue` tokens. */
async function list<T>(path: string, pageSize = 50, accept = "application/json"): Promise<T[]> {
  const items: T[] = [];
  let cont = "";
  do {
    const url = new URL(API + path);
    url.searchParams.set("limit", String(pageSize));
    if (cont) url.searchParams.set("continue", cont);
    const res = await fetch(url, { headers: { Accept: accept, ...(await authHeaders()) } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { items: T[]; metadata?: { continue?: string } };
    items.push(...body.items);
    cont = body.metadata?.continue ?? "";
  } while (cont);
  return items;
}

/** GET one object. */
async function getOne<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { Accept: "application/json", ...(await authHeaders()) } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export const listVulnerabilityReports = () =>
  list<VulnerabilityReport>("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports");

export const listReplicaSets = () => list<ReplicaSet>("/apis/apps/v1/replicasets", 500);

/**
 * List only the objects' metadata (PartialObjectMetadataList): owners and
 * labels, never a Pod's spec, so env values and the like are never fetched.
 * RBAC still needs `list` on the resource.
 */
const listMetadata = (path: string) =>
  list<MetadataOnly>(path, 500, "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json");

export const listPodMetadata = () => listMetadata("/api/v1/pods");
export const listJobMetadata = () => listMetadata("/apis/batch/v1/jobs");

export const listPolicyReports = () => list<PolicyReport>("/apis/wgpolicyk8s.io/v1alpha2/policyreports", 200);
export const listClusterPolicyReports = () =>
  list<PolicyReport>("/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports", 200);

// Exposure (exposure.ts). Services carry no secrets (type and selector are
// all that's used); HTTPRoutes are routing rules.
export const listServices = () => list<Service>("/api/v1/services", 500);
export const listHTTPRoutes = () => list<HTTPRoute>("/apis/gateway.networking.k8s.io/v1/httproutes", 500);

/** cloudflared's tunnel ingress rules (a Role in the cloudflared namespace allows this one ConfigMap). */
export const getTunnelConfig = () =>
  getOne<ConfigMap>(
    `/api/v1/namespaces/${process.env.TUNNEL_CONFIG_NAMESPACE ?? "cloudflared"}/configmaps/${process.env.TUNNEL_CONFIG_NAME ?? "cloudflared-config"}`,
  );
