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

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    return { Authorization: `Bearer ${t}` };
  } catch {
    return {}; // local run through kubectl proxy
  }
}

/** GET a list endpoint, following `continue` tokens. */
async function list<T>(path: string, pageSize = 50): Promise<T[]> {
  const items: T[] = [];
  let cont = "";
  do {
    const url = new URL(API + path);
    url.searchParams.set("limit", String(pageSize));
    if (cont) url.searchParams.set("continue", cont);
    const res = await fetch(url, { headers: { Accept: "application/json", ...(await authHeaders()) } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { items: T[]; metadata?: { continue?: string } };
    items.push(...body.items);
    cont = body.metadata?.continue ?? "";
  } while (cont);
  return items;
}

export const listVulnerabilityReports = () =>
  list<VulnerabilityReport>("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports");

export const listReplicaSets = () => list<ReplicaSet>("/apis/apps/v1/replicasets", 500);
