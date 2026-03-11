const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string>),
    },
  });

  if (res.status === 401) {
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login") && !window.location.pathname.startsWith("/auth")) {
      window.location.href = "/login";
    }
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
  session: () => apiFetch<{ telegram_id: number; name: string; is_admin: boolean; lang: string }>("/api/v1/auth/session"),
  refresh: () => apiFetch<{ ok: boolean }>("/api/v1/auth/refresh", { method: "POST" }),
  logout: () => apiFetch<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
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
