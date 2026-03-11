const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// Server API
export const serversApi = {
  list: () => apiFetch<any[]>("/api/v1/servers/"),
  get: (id: string) => apiFetch<any>(`/api/v1/servers/${id}`),
  metrics: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/metrics`),
};

// Instance API
export const instancesApi = {
  list: () => apiFetch<any[]>("/api/v1/instances/"),
  get: (id: string) => apiFetch<any>(`/api/v1/instances/${id}`),
};

// Vito API
export const vitoApi = {
  chat: (message: string, context: Record<string, any> = {}) =>
    apiFetch<{ reply: string; actions_taken: string[]; suggestions: string[] }>(
      "/api/v1/vito/chat",
      { method: "POST", body: JSON.stringify({ message, context }) }
    ),
};
