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
  remove: (id: string, destroyCloud?: boolean) =>
    apiFetch<{ detail: string }>(`/api/v1/servers/${id}${destroyCloud ? "?destroy_cloud=true" : ""}`, { method: "DELETE" }),
  refreshSpecs: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/refresh-specs`, { method: "POST" }),
  // Enhanced metrics
  detailedMetrics: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/metrics/detailed`),
  // Services
  services: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/services`),
  serviceAction: (id: string, serviceName: string, action: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/services/${serviceName}/action`, {
      method: "POST", body: JSON.stringify({ action }),
    }),
  // Firewall
  firewall: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/firewall`),
  addFirewallRule: (id: string, data: { port: number; protocol?: string; source?: string; action?: string; comment?: string }) =>
    apiFetch<any>(`/api/v1/servers/${id}/firewall`, { method: "POST", body: JSON.stringify(data) }),
  deleteFirewallRule: (id: string, ruleNumber: number) =>
    apiFetch<any>(`/api/v1/servers/${id}/firewall/${ruleNumber}`, { method: "DELETE" }),
  toggleFirewall: (id: string, enabled: boolean) =>
    apiFetch<any>(`/api/v1/servers/${id}/firewall/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),
  // Cron Jobs
  cronJobs: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/cron`),
  addCronJob: (id: string, data: { schedule: string; command: string }) =>
    apiFetch<any>(`/api/v1/servers/${id}/cron`, { method: "POST", body: JSON.stringify(data) }),
  deleteCronJob: (id: string, lineNumber: number) =>
    apiFetch<any>(`/api/v1/servers/${id}/cron/${lineNumber}`, { method: "DELETE" }),
  // Server Logs
  serverLogs: (id: string, type: string = "syslog", lines: number = 100) =>
    apiFetch<any>(`/api/v1/servers/${id}/logs?type=${type}&lines=${lines}`),
  // Processes
  processes: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/processes`),
  killProcess: (id: string, pid: number, signal: string = "TERM") =>
    apiFetch<any>(`/api/v1/servers/${id}/processes/${pid}/kill`, {
      method: "POST", body: JSON.stringify({ signal }),
    }),
  // SSH Keys
  sshKeys: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/ssh-keys`),
  addSshKey: (id: string, publicKey: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssh-keys`, { method: "POST", body: JSON.stringify({ public_key: publicKey }) }),
  deleteSshKey: (id: string, index: number) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssh-keys/${index}`, { method: "DELETE" }),
  // PostgreSQL
  databases: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/databases`),
  postgresConfig: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/postgres-config`),
  updatePostgresConfig: (id: string, params: Record<string, string>) =>
    apiFetch<any>(`/api/v1/servers/${id}/postgres-config`, { method: "PATCH", body: JSON.stringify({ params }) }),
  databaseStats: (id: string, dbName: string) => apiFetch<any>(`/api/v1/servers/${id}/databases/${dbName}/stats`),
  // Activity
  activity: (id: string, limit: number = 50) => apiFetch<any>(`/api/v1/servers/${id}/activity?limit=${limit}`),
  // Settings
  updateSettings: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/servers/${id}/settings`, { method: "PATCH", body: JSON.stringify(data) }),
  // Uptime
  uptime: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/uptime`),
  // Hardware upgrade
  upgradePlans: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/upgrade-plans`),
  resize: (id: string, targetPlan: string, upgradeDisk: boolean = true) =>
    apiFetch<any>(`/api/v1/servers/${id}/resize`, { method: "POST", body: JSON.stringify({ target_plan: targetPlan, upgrade_disk: upgradeDisk }) }),
  // Monitoring History
  metricsHistory: (id: string, period: string = "1h") =>
    apiFetch<any>(`/api/v1/servers/${id}/metrics/history?period=${period}`),
  alertsConfig: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/alerts/config`),
  updateAlertsConfig: (id: string, config: Record<string, any>) =>
    apiFetch<any>(`/api/v1/servers/${id}/alerts/config`, { method: "PATCH", body: JSON.stringify(config) }),
  alertsStatus: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/alerts/status`),
  installSysstat: (id: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/install-sysstat`, { method: "POST" }),
  // Fail2ban Management
  fail2ban: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/fail2ban`),
  fail2banUnban: (id: string, jail: string, ip: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/fail2ban/${jail}/unban`, { method: "POST", body: JSON.stringify({ ip }) }),
  fail2banBan: (id: string, jail: string, ip: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/fail2ban/${jail}/ban`, { method: "POST", body: JSON.stringify({ ip }) }),
  fail2banToggle: (id: string, enabled: boolean) =>
    apiFetch<any>(`/api/v1/servers/${id}/fail2ban/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),
  // SSL / Let's Encrypt
  sslCertificates: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/ssl`),
  sslIssue: (id: string, data: { domain: string; email?: string }) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssl/issue`, { method: "POST", body: JSON.stringify(data) }),
  sslRenew: (id: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssl/renew`, { method: "POST" }),
  sslRevoke: (id: string, domain: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssl/${domain}`, { method: "DELETE" }),
  sslInstallCertbot: (id: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssl/install-certbot`, { method: "POST" }),
  // Security Scanning
  securityScan: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/security/scan`),
  securityFix: (id: string, actions: string[]) =>
    apiFetch<any>(`/api/v1/servers/${id}/security/fix`, { method: "POST", body: JSON.stringify({ actions }) }),
  securityScanHistory: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/security/scan/history`),
  // Nginx Sites Management
  nginxSites: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/nginx/sites`),
  nginxSiteConfig: (id: string, siteName: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/nginx/sites/${siteName}/config`),
  nginxToggleSite: (id: string, siteName: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/nginx/sites/${siteName}/toggle`, { method: "POST" }),
  nginxTest: (id: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/nginx/test`, { method: "POST" }),
  // Docker Container Management
  dockerContainers: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/docker/containers`),
  dockerContainerAction: (id: string, containerId: string, action: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/docker/containers/${containerId}/action`, {
      method: "POST", body: JSON.stringify({ action }),
    }),
  dockerContainerLogs: (id: string, containerId: string, lines: number = 100) =>
    apiFetch<any>(`/api/v1/servers/${id}/docker/containers/${containerId}/logs?lines=${lines}`),
  // SSH Hardening
  sshHardening: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/ssh/hardening`),
  updateSshHardening: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/servers/${id}/ssh/hardening`, { method: "PATCH", body: JSON.stringify(data) }),
  // Swap Management
  swapInfo: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/swap`),
  createSwap: (id: string, sizeMb: number) =>
    apiFetch<any>(`/api/v1/servers/${id}/swap/create`, { method: "POST", body: JSON.stringify({ size_mb: sizeMb }) }),
  removeSwap: (id: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/swap`, { method: "DELETE" }),
  updateSwappiness: (id: string, value: number) =>
    apiFetch<any>(`/api/v1/servers/${id}/swap/swappiness`, { method: "PATCH", body: JSON.stringify({ value }) }),
  // Quick Actions
  quickActions: (id: string) => apiFetch<any[]>(`/api/v1/servers/${id}/quick-actions`),
  executeQuickAction: (id: string, action: string) =>
    apiFetch<any>(`/api/v1/servers/${id}/quick-actions`, { method: "POST", body: JSON.stringify({ action }) }),
  // Network
  networkOverview: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/network`),
  // Resource Forecasting
  forecast: (id: string) => apiFetch<any>(`/api/v1/servers/${id}/forecast`),
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
  updateSettings: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/instances/${id}/settings`, { method: "PATCH", body: JSON.stringify(data) }),
  updateDomain: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/instances/${id}/domain`, { method: "PATCH", body: JSON.stringify(data) }),
  // Addons
  listAddons: (id: string) => apiFetch<any[]>(`/api/v1/instances/${id}/addons`),
  updateEnterpriseAddons: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/enterprise/update`, { method: "POST" }),
  removeEnterpriseAddons: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/enterprise`, { method: "DELETE" }),
  // Git Addons
  addGitAddon: (id: string, data: { url: string; branch: string; copy_method?: string; specific_addons?: string[]; access_token?: string }) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/git`, { method: "POST", body: JSON.stringify(data) }),
  updateAddonSettings: (id: string, addonId: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/git/${addonId}/settings`, { method: "PATCH", body: JSON.stringify(data) }),
  updateGitAddon: (id: string, addonId: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/git/${addonId}/update`, { method: "POST" }),
  removeGitAddon: (id: string, addonId: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/git/${addonId}`, { method: "DELETE" }),
  getAddonModules: (id: string, addonId: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/git/${addonId}/modules`),
  checkConflicts: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/check-conflicts`),
  checkCompatibility: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/check-compatibility`),
  getOcaCatalog: () =>
    apiFetch<any[]>(`/api/v1/instances/oca-catalog`),
  // Marketplace
  getMarketplace: (id: string, params?: { search?: string; category?: string; source?: string; page?: number; per_page?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.category) qs.set("category", params.category);
    if (params?.source) qs.set("source", params.source);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.per_page) qs.set("per_page", String(params.per_page));
    return apiFetch<any>(`/api/v1/instances/${id}/marketplace?${qs}`);
  },
  installMarketplaceModule: (id: string, data: { repo_url: string; module_name: string; branch?: string }) =>
    apiFetch<any>(`/api/v1/instances/${id}/marketplace/install`, { method: "POST", body: JSON.stringify(data) }),
  uninstallMarketplaceModule: (id: string, addonId: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/marketplace/${addonId}`, { method: "DELETE" }),
  rebuildMarketplace: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/marketplace/rebuild`, { method: "POST" }),
  uploadToGithub: (id: string, data: { repo_name: string; description?: string }) =>
    apiFetch<any>(`/api/v1/instances/${id}/addons/upload-to-github`, { method: "POST", body: JSON.stringify(data) }),
  // Odoo Config (odoo.conf)
  getOdooConfig: (id: string, showAll: boolean = false) =>
    apiFetch<any>(`/api/v1/instances/${id}/odoo-config?show_all=${showAll}`),
  updateOdooConfig: (id: string, params: Record<string, any>) =>
    apiFetch<any>(`/api/v1/instances/${id}/odoo-config`, { method: "PATCH", body: JSON.stringify({ params }) }),
  applyConfigPreset: (id: string, presetName: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/odoo-config/preset/${presetName}`, { method: "POST" }),
  // Real-time Monitoring
  getMonitoring: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/monitoring`),
  getQuickMetrics: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/monitoring/quick`),
  // Staging
  getStaging: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/staging`),
  createStaging: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/staging`, { method: "POST" }),
  syncStaging: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/staging/sync`, { method: "POST" }),
  deleteStaging: (id: string) =>
    apiFetch<any>(`/api/v1/instances/${id}/staging`, { method: "DELETE" }),
};

// GitHub OAuth API
export const githubApi = {
  status: () => apiFetch<{ connected: boolean; username: string; avatar_url: string }>("/api/v1/settings/github/status"),
  authorize: (returnTo?: string) => {
    const qs = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
    return apiFetch<{ authorize_url: string }>(`/api/v1/settings/github/authorize${qs}`);
  },
  disconnect: () => apiFetch<{ ok: boolean }>("/api/v1/settings/github/disconnect", { method: "POST" }),
  repos: (params?: { search?: string; page?: number; per_page?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.per_page) qs.set("per_page", String(params.per_page));
    return apiFetch<{ repos: any[]; total: number; page: number }>(`/api/v1/settings/github/repos?${qs}`);
  },
  branches: (owner: string, repo: string) =>
    apiFetch<{ branches: { name: string; protected: boolean }[] }>(`/api/v1/settings/github/repos/${owner}/${repo}/branches`),
};

// Backup API
export const backupsApi = {
  list: (instanceId?: string) =>
    apiFetch<any[]>(instanceId ? `/api/v1/backups/?instance_id=${instanceId}` : "/api/v1/backups"),
  stats: (instanceId: string) =>
    apiFetch<{ total_backups: number; completed_backups: number; failed_backups: number; total_size_mb: number; last_backup_at: string | null; last_backup_status: string | null }>(
      `/api/v1/backups/stats?instance_id=${instanceId}`
    ),
  create: (instanceId: string, includeFilestore: boolean = true) =>
    apiFetch<any>(`/api/v1/backups/${instanceId}`, {
      method: "POST",
      body: JSON.stringify({ include_filestore: includeFilestore }),
    }),
  restore: (backupId: string, includeFilestore: boolean = true) =>
    apiFetch<any>(`/api/v1/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({ include_filestore: includeFilestore }),
    }),
  cancel: (backupId: string) =>
    apiFetch<any>(`/api/v1/backups/${backupId}/cancel`, { method: "POST" }),
  remove: (backupId: string) =>
    apiFetch<any>(`/api/v1/backups/${backupId}`, { method: "DELETE" }),
};

// Migrations API — server-to-server migration
export const migrationsApi = {
  list: () => apiFetch<any[]>("/api/v1/migrations"),
  get: (id: string) => apiFetch<any>(`/api/v1/migrations/${id}`),
  create: (data: { source_instance_id: string; target_server_id: string; strategy?: string; include_filestore?: boolean; target_database?: string }) =>
    apiFetch<any>("/api/v1/migrations", { method: "POST", body: JSON.stringify(data) }),
  estimate: (instanceId: string, targetServerId: string) =>
    apiFetch<any>(`/api/v1/migrations/${instanceId}/estimate?target_server_id=${targetServerId}`, { method: "POST" }),
};

// Clones API — staging, development, testing clones
export const clonesApi = {
  list: (sourceInstanceId?: string) =>
    apiFetch<any[]>(sourceInstanceId ? `/api/v1/clones?source_instance_id=${sourceInstanceId}` : "/api/v1/clones"),
  get: (id: string) => apiFetch<any>(`/api/v1/clones/${id}`),
  create: (data: { source_instance_id: string; clone_type?: string; name?: string; clone_database?: string; neutralize?: boolean; base_url?: string }) =>
    apiFetch<any>("/api/v1/clones", { method: "POST", body: JSON.stringify(data) }),
  start: (id: string) => apiFetch<any>(`/api/v1/clones/${id}/start`, { method: "POST" }),
  stop: (id: string) => apiFetch<any>(`/api/v1/clones/${id}/stop`, { method: "POST" }),
  sync: (id: string) => apiFetch<any>(`/api/v1/clones/${id}/sync`, { method: "POST" }),
  destroy: (id: string) => apiFetch<any>(`/api/v1/clones/${id}`, { method: "DELETE" }),
};

// Backup Schedules API — automated periodic backups
export const backupSchedulesApi = {
  list: (instanceId?: string) =>
    apiFetch<any[]>(instanceId ? `/api/v1/backup-schedules?instance_id=${instanceId}` : "/api/v1/backup-schedules"),
  get: (id: string) => apiFetch<any>(`/api/v1/backup-schedules/${id}`),
  create: (data: {
    instance_id: string; cron_expression?: string; timezone?: string; backup_format?: string;
    include_filestore?: boolean; destination_ids?: string[]; keep_daily?: number; keep_weekly?: number;
    keep_monthly?: number; notify_on_success?: boolean; notify_on_failure?: boolean; notification_channels?: string[];
    verify_after_backup?: boolean; stop_instance_during_backup?: boolean; pre_backup_command?: string; post_backup_command?: string;
  }) => apiFetch<any>("/api/v1/backup-schedules", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/api/v1/backup-schedules/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  toggle: (id: string) =>
    apiFetch<any>(`/api/v1/backup-schedules/${id}/toggle`, { method: "POST" }),
  remove: (id: string) =>
    apiFetch<any>(`/api/v1/backup-schedules/${id}`, { method: "DELETE" }),
  runNow: (id: string) =>
    apiFetch<any>(`/api/v1/backup-schedules/${id}/run`, { method: "POST" }),
};

// Cloud Provider API — unified multi-provider
export const cloudApi = {
  providers: () => apiFetch<{ id: string; name: string; available: boolean; currency: string }[]>("/api/v1/cloud/available"),
  cmsRequirements: () => apiFetch<any[]>("/api/v1/cloud/cms-requirements"),
  workloadTiers: () => apiFetch<any[]>("/api/v1/cloud/workload-tiers"),
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

// Settings API
export const settingsApi = {
  // API Keys
  listApiKeys: () => apiFetch<any[]>("/api/v1/settings/api-keys"),
  createApiKey: (name: string) =>
    apiFetch<any>("/api/v1/settings/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  deleteApiKey: (id: string) =>
    apiFetch<any>(`/api/v1/settings/api-keys/${id}`, { method: "DELETE" }),
  toggleApiKey: (id: string) =>
    apiFetch<any>(`/api/v1/settings/api-keys/${id}/toggle`, { method: "PATCH" }),
  // Backup Storages
  listBackupStorages: () => apiFetch<any[]>("/api/v1/settings/backup-storages"),
  createBackupStorage: (data: { name: string; provider: string; config: Record<string, any> }) =>
    apiFetch<any>("/api/v1/settings/backup-storages", { method: "POST", body: JSON.stringify(data) }),
  activateBackupStorage: (id: string) =>
    apiFetch<any>(`/api/v1/settings/backup-storages/${id}/activate`, { method: "POST" }),
  deleteBackupStorage: (id: string) =>
    apiFetch<any>(`/api/v1/settings/backup-storages/${id}`, { method: "DELETE" }),
  // Account
  getAccount: () => apiFetch<any>("/api/v1/settings/account"),
  // Enterprise Edition
  listEnterprise: () => apiFetch<any[]>("/api/v1/settings/enterprise"),
  deleteEnterprise: (version: string) =>
    apiFetch<any>(`/api/v1/settings/enterprise/${version}`, { method: "DELETE" }),
  uploadEnterprise: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/v1/settings/enterprise/upload`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

// Database Explorer API
export const databaseApi = {
  // Tables
  listTables: (instanceId: string) =>
    apiFetch<any[]>(`/api/v1/database/${instanceId}/tables`),
  getColumns: (instanceId: string, table: string) =>
    apiFetch<any[]>(`/api/v1/database/${instanceId}/tables/${table}/columns`),
  // Records (POST for body params)
  getRecords: (instanceId: string, table: string, params: {
    page?: number; page_size?: number; order_by?: string; order_dir?: string;
    search?: string; filters?: Record<string, string>;
  } = {}) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/tables/${table}/records`, {
      method: "POST", body: JSON.stringify(params),
    }),
  updateRecord: (instanceId: string, table: string, recordId: number, updates: Record<string, any>) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/tables/${table}/records/${recordId}`, {
      method: "PATCH", body: JSON.stringify({ updates }),
    }),
  insertRecord: (instanceId: string, table: string, values: Record<string, any>) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/tables/${table}/records`, {
      method: "PUT", body: JSON.stringify({ values }),
    }),
  deleteRecord: (instanceId: string, table: string, recordId: number) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/tables/${table}/records/${recordId}`, {
      method: "DELETE",
    }),
  // SQL Console
  executeQuery: (instanceId: string, sql: string, maxRows: number = 500) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/query`, {
      method: "POST", body: JSON.stringify({ sql, max_rows: maxRows }),
    }),
  // Statistics
  getStats: (instanceId: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/stats`),
  getIndexes: (instanceId: string, table: string) =>
    apiFetch<any[]>(`/api/v1/database/${instanceId}/tables/${table}/indexes`),
  // Export
  exportTable: (instanceId: string, table: string) =>
    `/api/v1/database/${instanceId}/tables/${table}/export`,
  // Quick Actions
  resetPassword: (instanceId: string, newPassword: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/reset-password`, {
      method: "POST", body: JSON.stringify({ new_password: newPassword }),
    }),
  cleanupSessions: (instanceId: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/cleanup-sessions`, { method: "POST" }),
  cleanupAttachments: (instanceId: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/cleanup-attachments`, { method: "POST" }),
  getActiveUsers: (instanceId: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/users`),
  getInstalledModules: (instanceId: string) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/modules`),
  toggleUser: (instanceId: string, userId: number, active: boolean) =>
    apiFetch<any>(`/api/v1/database/${instanceId}/actions/toggle-user`, {
      method: "POST", body: JSON.stringify({ user_id: userId, active }),
    }),
};
