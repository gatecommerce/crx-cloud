import { getToken, logout } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    logout();
    throw new Error("Session expired");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API error: ${res.status} ${body}`);
  }

  return res.json();
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    apiFetch<{ access_token: string; token_type: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, full_name: string) =>
    apiFetch<{ id: string; email: string; full_name: string }>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, full_name }),
    }),
  me: () => apiFetch<{ id: string; email: string; full_name: string; is_admin: boolean }>("/api/v1/auth/me"),
};

// Server API
export const serversApi = {
  list: () => apiFetch<any[]>("/api/v1/servers/"),
  get: (id: string) => apiFetch<any>(`/api/v1/servers/${id}`),
  add: (data: { name: string; server_type: string; provider: string; endpoint: string; ssh_user?: string; ssh_key_path?: string; kubeconfig?: string; namespace?: string }) =>
    apiFetch<any>("/api/v1/servers/", { method: "POST", body: JSON.stringify(data) }),
  metrics: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/metrics`),
  remove: (id: string) => apiFetch<void>(`/api/v1/servers/${id}`, { method: "DELETE" }),
};

// Instance API
export const instancesApi = {
  list: (serverId?: string) =>
    apiFetch<any[]>(serverId ? `/api/v1/instances/?server_id=${serverId}` : "/api/v1/instances/"),
  get: (id: string) => apiFetch<any>(`/api/v1/instances/${id}`),
  create: (data: { name: string; cms_type: string; version: string; server_id: string; domain?: string; workers?: number; ram_mb?: number; cpu_cores?: number }) =>
    apiFetch<any>("/api/v1/instances/", { method: "POST", body: JSON.stringify(data) }),
  restart: (id: string) => apiFetch<any>(`/api/v1/instances/${id}/restart`, { method: "POST" }),
  scale: (id: string, workers: number) =>
    apiFetch<any>(`/api/v1/instances/${id}/scale`, { method: "POST", body: JSON.stringify({ workers }) }),
  remove: (id: string) => apiFetch<void>(`/api/v1/instances/${id}`, { method: "DELETE" }),
};

// Backup API
export const backupsApi = {
  list: (instanceId?: string) =>
    apiFetch<any[]>(instanceId ? `/api/v1/backups/?instance_id=${instanceId}` : "/api/v1/backups/"),
  create: (instanceId: string) =>
    apiFetch<any>(`/api/v1/backups/${instanceId}`, { method: "POST" }),
  restore: (backupId: string) =>
    apiFetch<any>(`/api/v1/backups/${backupId}/restore`, { method: "POST" }),
};

// Vito API
export const vitoApi = {
  chat: (message: string, context: Record<string, any> = {}) =>
    apiFetch<{ reply: string; actions_taken: string[]; suggestions: string[] }>(
      "/api/v1/vito/chat",
      { method: "POST", body: JSON.stringify({ message, context }) }
    ),
};
