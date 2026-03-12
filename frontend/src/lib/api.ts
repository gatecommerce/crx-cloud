// All API calls go through Next.js rewrites (/api/* → backend)
// This keeps cookies same-origin and works in Docker

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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
  list: () => apiFetch<any[]>("/api/v1/servers"),
  get: (id: string) => apiFetch<any>(`/api/v1/servers/${id}`),
  sshKey: () => apiFetch<{ public_key: string }>("/api/v1/servers/ssh-key"),
  testConnection: (data: { endpoint: string; ssh_user?: string; password?: string; server_type?: string }) =>
    apiFetch<{ connected: boolean; hostname: string; error: string }>(
      "/api/v1/servers/test-connection",
      { method: "POST", body: JSON.stringify(data) }
    ),
  connect: (data: { name: string; server_type?: string; provider?: string; endpoint: string; ssh_user?: string; password?: string; region?: string }) =>
    apiFetch<any>("/api/v1/servers", { method: "POST", body: JSON.stringify(data) }),
  metrics: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/metrics`),
  precheck: (data: { endpoint: string; ssh_user?: string; password?: string }) =>
    apiFetch<{
      safe: boolean; risk_level: string; threats: { severity: string; category: string; detail: string }[];
      threat_count: number; system_info: Record<string, any>; recommendations: string[]; error?: string;
    }>("/api/v1/servers/precheck", { method: "POST", body: JSON.stringify(data) }),
  sanitize: (data: { endpoint: string; ssh_user?: string; password?: string; threats: any[] }) =>
    apiFetch<{ success: boolean; actions: { action: string; ok: boolean; detail: string }[]; remaining_threats: number; message: string }>(
      "/api/v1/servers/sanitize", { method: "POST", body: JSON.stringify(data) }
    ),
  security: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/security`),
  updates: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/updates`),
  reboot: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/reboot`, { method: "POST" }),
  remove: (id: string) => apiFetch<void>(`/api/v1/servers/${id}`, { method: "DELETE" }),
};

// Instance API
export const instancesApi = {
  list: (serverId?: string) =>
    apiFetch<any[]>(serverId ? `/api/v1/instances/?server_id=${serverId}` : "/api/v1/instances"),
  get: (id: string) => apiFetch<any>(`/api/v1/instances/${id}`),
  create: (data: { name: string; cms_type: string; version: string; server_id: string; domain?: string; workers?: number; ram_mb?: number; cpu_cores?: number }) =>
    apiFetch<any>("/api/v1/instances", { method: "POST", body: JSON.stringify(data) }),
  restart: (id: string) => apiFetch<any>(`/api/v1/instances/${id}/restart`, { method: "POST" }),
  stop: (id: string) => apiFetch<any>(`/api/v1/instances/${id}/stop`, { method: "POST" }),
  start: (id: string) => apiFetch<any>(`/api/v1/instances/${id}/start`, { method: "POST" }),
  health: (id: string) => apiFetch<any>(`/api/v1/instances/${id}/health`),
  logs: (id: string, lines: number = 100) => apiFetch<any>(`/api/v1/instances/${id}/logs?lines=${lines}`),
  scale: (id: string, workers: number) =>
    apiFetch<any>(`/api/v1/instances/${id}/scale?workers=${workers}`, { method: "POST" }),
  remove: (id: string) => apiFetch<void>(`/api/v1/instances/${id}`, { method: "DELETE" }),
};

// Backup API
export const backupsApi = {
  list: (instanceId?: string) =>
    apiFetch<any[]>(instanceId ? `/api/v1/backups/?instance_id=${instanceId}` : "/api/v1/backups"),
  create: (instanceId: string) =>
    apiFetch<any>(`/api/v1/backups/${instanceId}`, { method: "POST" }),
  restore: (backupId: string) =>
    apiFetch<any>(`/api/v1/backups/${backupId}/restore`, { method: "POST" }),
};

// Cloud Provider API — unified multi-provider
export const cloudApi = {
  providers: () => apiFetch<{ id: string; name: string; available: boolean; currency: string }[]>("/api/v1/cloud/available"),
  cmsRequirements: () => apiFetch<any[]>("/api/v1/cloud/cms-requirements"),
  // Generic endpoints per provider
  plans: (provider: string) => apiFetch<any[]>(`/api/v1/cloud/${provider}/plans`),
  regions: (provider: string) => apiFetch<any[]>(`/api/v1/cloud/${provider}/regions`),
  servers: (provider: string) => apiFetch<any[]>(`/api/v1/cloud/${provider}/servers`),
  create: (provider: string, data: { name: string; plan: string; region: string }) =>
    apiFetch<any>(`/api/v1/cloud/${provider}/create`, { method: "POST", body: JSON.stringify(data) }),
};

// Vito API
export const vitoApi = {
  chat: (message: string, context: Record<string, any> = {}) =>
    apiFetch<{ reply: string; actions_taken: string[]; suggestions: string[] }>(
      "/api/v1/vito/chat",
      { method: "POST", body: JSON.stringify({ message, context }) }
    ),
};
