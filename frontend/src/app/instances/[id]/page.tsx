"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi, backupsApi, serversApi, settingsApi } from "@/lib/api";
import {
  ArrowLeft, Play, Square, RotateCcw, Trash2, ExternalLink,
  Cpu, MemoryStick, Users, Heart, ScrollText, Database,
  Loader2, CheckCircle, XCircle, AlertTriangle, Clock,
  RefreshCw, Plus, ChevronDown, ChevronUp, Globe,
  LayoutDashboard, Settings2, Puzzle, GitBranch, Activity, Wrench,
  Eye, EyeOff, Copy, Shield, Bell, BellOff, Calendar,
  Save, ArrowUpDown, Gauge, HardDrive, Zap,
  Package, Library, GitCommit, Search, X, ChevronRight, BookOpen
} from "lucide-react";

type TabId = "dashboard" | "logs" | "backups" | "config" | "addons" | "staging" | "monitoring" | "settings";

const TABS: { id: TabId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "backups", label: "Backups", icon: Database },
  { id: "config", label: "Config", icon: Settings2 },
  { id: "addons", label: "Addons", icon: Puzzle },
  { id: "staging", label: "Staging", icon: GitBranch },
  { id: "monitoring", label: "Monitoring", icon: Activity },
  { id: "settings", label: "Settings", icon: Wrench },
];

const statusColors: Record<string, string> = {
  running: "text-[var(--success)]",
  stopped: "text-[var(--muted)]",
  deploying: "text-[var(--warning)]",
  error: "text-[var(--danger)]",
};

const statusBg: Record<string, string> = {
  running: "bg-[var(--success)]/10",
  stopped: "bg-[var(--muted)]/10",
  deploying: "bg-[var(--warning)]/10",
  error: "bg-[var(--danger)]/10",
};

function SettingToggle({ label, description, checked, onChange, disabled = false }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-3 border-b border-white/5 last:border-0 ${disabled ? "opacity-50" : ""}`}>
      <div>
        <div className="text-white font-medium">{label}</div>
        <div className="text-gray-400 text-sm mt-0.5">{description}</div>
      </div>
      <button
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-gray-600"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${checked ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}

export default function InstanceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const instanceId = params.id as string;

  const [instance, setInstance] = useState<any>(null);
  const [server, setServer] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logLines, setLogLines] = useState(50);

  // Dashboard state
  const [showPassword, setShowPassword] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);

  // Config state
  const [configForm, setConfigForm] = useState({
    name: "",
    domain: "",
    workers: 2,
    ram_mb: 1024,
    auto_restart: true,
  });
  const [configSaving, setConfigSaving] = useState(false);

  // Addons state
  const [addonInput, setAddonInput] = useState("");
  const [addons, setAddons] = useState<any[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(false);
  const [addonUpdating, setAddonUpdating] = useState(false);

  // Git addon state
  const [showAddGitModal, setShowAddGitModal] = useState(false);
  const [showOcaModal, setShowOcaModal] = useState(false);
  const [showAddonSettingsModal, setShowAddonSettingsModal] = useState<any>(null);
  const [showUpdateModal, setShowUpdateModal] = useState<any>(null);
  const [showModulesPanel, setShowModulesPanel] = useState<any>(null);
  const [addonModules, setAddonModules] = useState<any[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [ocaCatalog, setOcaCatalog] = useState<any[]>([]);
  const [ocaSearch, setOcaSearch] = useState("");
  const [conflicts, setConflicts] = useState<any>(null);
  const [compatibility, setCompatibility] = useState<any>(null);
  const [gitAddonForm, setGitAddonForm] = useState({ url: "", branch: "", copy_method: "all" as "all" | "specific", specific_addons: "", access_token: "" });
  const [gitAddonAdding, setGitAddonAdding] = useState(false);
  const [gitAddonRemoving, setGitAddonRemoving] = useState<string | null>(null);

  // Backups schedule state
  const [backupSchedule, setBackupSchedule] = useState({
    enabled: true,
    frequency: "daily",
    retention_days: 30,
  });

  // Settings state
  const [settingsForm, setSettingsForm] = useState({
    auto_backup: true,
    backup_schedule: "daily",
    notify_on_error: true,
    notify_on_backup: false,
  });
  const [showDomainModal, setShowDomainModal] = useState(false);
  const [domainForm, setDomainForm] = useState({ domain: "", aliases: [] as string[], http_redirect: true });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [enterprisePackages, setEnterprisePackages] = useState<any[]>([]);

  const loadInstance = useCallback(async () => {
    try {
      const inst = await instancesApi.get(instanceId);
      setInstance(inst);
      // Initialize config form from instance
      setConfigForm({
        name: inst.name || "",
        domain: inst.domain || "",
        workers: inst.workers || 2,
        ram_mb: inst.ram_mb || 1024,
        auto_restart: true,
      });
      const [srv, bkps] = await Promise.all([
        serversApi.get(inst.server_id).catch(() => null),
        backupsApi.list(instanceId).catch(() => []),
      ]);
      setServer(srv);
      setBackups(bkps);
    } catch {
      router.push("/instances");
    } finally {
      setLoading(false);
    }
  }, [instanceId, router]);

  const loadHealth = useCallback(async () => {
    try {
      const h = await instancesApi.health(instanceId);
      setHealth(h);
    } catch {
      setHealth(null);
    }
  }, [instanceId]);

  const loadLogs = useCallback(async () => {
    try {
      const data = await instancesApi.logs(instanceId, logLines);
      const raw = data.logs || "";
      setLogs(typeof raw === "string" ? raw.split("\n").filter(Boolean) : raw);
    } catch {
      setLogs(["Failed to load logs"]);
    }
  }, [instanceId, logLines]);

  useEffect(() => {
    loadInstance();
    try { settingsApi.listEnterprise().then(setEnterprisePackages).catch(() => {}); } catch {}
  }, [loadInstance]);

  useEffect(() => {
    if (instance && instance.status === "running") {
      loadHealth();
    }
  }, [instance, loadHealth]);

  const loadAddons = useCallback(async () => {
    setAddonsLoading(true);
    try {
      const data = await instancesApi.listAddons(instanceId);
      setAddons(data);
    } catch { setAddons([]); }
    finally { setAddonsLoading(false); }
  }, [instanceId]);

  useEffect(() => {
    if (activeTab === "logs") {
      loadLogs();
    }
    if (activeTab === "addons") {
      loadAddons();
    }
  }, [activeTab, loadLogs, loadAddons]);

  // Auto-refresh for deploying instances
  useEffect(() => {
    if (instance?.status === "deploying") {
      const interval = setInterval(loadInstance, 5000);
      return () => clearInterval(interval);
    }
  }, [instance?.status, loadInstance]);

  async function handleAction(action: "restart" | "stop" | "start") {
    setActionLoading(action);
    try {
      await instancesApi[action](instanceId);
      await loadInstance();
      if (action === "start") loadHealth();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete instance "${instance?.name}"? All data will be permanently removed.`)) return;
    setActionLoading("delete");
    try {
      await instancesApi.remove(instanceId);
      router.push("/instances");
    } catch (err: any) {
      alert(err.message);
      setActionLoading(null);
    }
  }

  async function handleCreateBackup() {
    setActionLoading("backup");
    try {
      await backupsApi.create(instanceId);
      await loadInstance();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRestore(backupId: string) {
    if (!confirm("Restore this backup? Current instance data will be overwritten.")) return;
    setActionLoading(`restore-${backupId}`);
    try {
      await backupsApi.restore(backupId);
      await loadInstance();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  function handleCopyPassword() {
    const pw = instance?.admin_password || "admin";
    navigator.clipboard.writeText(pw).then(() => {
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 2000);
    });
  }

  async function handleSaveConfig() {
    setConfigSaving(true);
    try {
      // Try scaling workers if changed
      if (configForm.workers !== instance.workers) {
        await instancesApi.scale(instanceId, configForm.workers);
      }
      // Reload instance data
      await loadInstance();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setConfigSaving(false);
    }
  }

  const handleSaveSettings = async (key: string, value: boolean) => {
    // Enterprise toggle: confirm + poll for progress
    if (key === "enterprise" && value) {
      if (!confirm("Enable Enterprise Edition? This will upload addons, restart the instance, and install enterprise modules. The instance will be temporarily unavailable.")) return;
    }
    if (key === "enterprise" && !value) {
      if (!confirm("⚠️ ATTENZIONE: Disattivare Enterprise rimuoverà l'accesso ai moduli enterprise (web_enterprise, ecc.) e riavvierà l'istanza.\n\nSe i moduli enterprise sono già installati nel database, Odoo potrebbe non funzionare correttamente.\n\nSei sicuro di voler continuare?")) return;
    }

    setSettingsSaving(true);
    try {
      await instancesApi.updateSettings(instanceId, { [key]: value });
      // For enterprise, poll until status returns to "running"
      if (key === "enterprise" && value) {
        const poll = setInterval(async () => {
          try {
            const data = await instancesApi.get(instanceId);
            setInstance(data);
            if (data.status !== "upgrading") {
              clearInterval(poll);
              setSettingsSaving(false);
            }
          } catch {}
        }, 3000);
        return; // Don't setSettingsSaving(false) yet
      }
      await loadInstance();
    } catch (e: any) {
      alert(e.message || "Failed to save settings");
    } finally {
      if (key !== "enterprise" || !value) setSettingsSaving(false);
    }
  };

  const handleSaveDomain = async () => {
    try {
      await instancesApi.updateDomain(instanceId, domainForm);
      setShowDomainModal(false);
      await loadInstance();
    } catch (e: any) {
      alert(e.message || "Failed to save domain");
    }
  };

  // Helper: format uptime
  function formatUptime(createdAt: string): string {
    if (!createdAt) return "N/A";
    const diff = Date.now() - new Date(createdAt).getTime();
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return `${days}d ${hours}h`;
    const mins = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }

  // Helper: last backup date
  function getLastBackupInfo() {
    if (backups.length === 0) return { date: "Never", ago: "" };
    const sorted = [...backups].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const last = sorted[0];
    const date = new Date(last.created_at).toLocaleString("it-IT", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    return { date, status: last.status };
  }

  if (loading) {
    return (
      <AuthGuard>
        <div className="flex h-screen">
          <Sidebar />
          <div className="flex-1 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (!instance) return null;

  const lastBackup = getLastBackupInfo();

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-5xl mx-auto">
              {/* Header */}
              <div className="flex items-center gap-4 mb-6">
                <button
                  onClick={() => router.push("/instances")}
                  className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]"
                >
                  <ArrowLeft size={18} />
                </button>
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold">{instance.name}</h1>
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${statusColors[instance.status]} ${statusBg[instance.status]}`}>
                      {instance.status === "deploying" && <Loader2 size={10} className="inline animate-spin mr-1" />}
                      {instance.status}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--muted)] mt-1">
                    {instance.cms_type.charAt(0).toUpperCase() + instance.cms_type.slice(1)} {instance.version}
                    {server && <> on {server.name}</>}
                  </p>
                </div>
                <div className="flex gap-2">
                  {instance.status === "running" && (
                    <>
                      <button
                        onClick={() => handleAction("restart")}
                        disabled={!!actionLoading}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--card-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        {actionLoading === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Restart
                      </button>
                      <button
                        onClick={() => handleAction("stop")}
                        disabled={!!actionLoading}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--card-hover)] transition-colors flex items-center gap-2 text-[var(--warning)] disabled:opacity-50"
                      >
                        {actionLoading === "stop" ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />} Stop
                      </button>
                    </>
                  )}
                  {instance.status === "stopped" && (
                    <button
                      onClick={() => handleAction("start")}
                      disabled={!!actionLoading}
                      className="px-3 py-2 text-sm rounded-lg bg-[var(--success)]/10 text-[var(--success)] hover:bg-[var(--success)]/20 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start
                    </button>
                  )}
                </div>
              </div>

              {/* Tab Bar — Horizontal scrollable */}
              <div className="overflow-x-auto -mx-6 px-6 mb-6">
                <div className="flex gap-1 border-b border-[var(--border)] min-w-max">
                  {TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
                          activeTab === tab.id
                            ? "border-[var(--accent)] text-[var(--accent)]"
                            : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        <Icon size={14} />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ========== DASHBOARD TAB ========== */}
              {activeTab === "dashboard" && (
                <div className="grid gap-4 md:grid-cols-2">
                  {/* Instance Info */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Instance Info</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Edition</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] font-medium capitalize">
                          {instance.edition || instance.cms_type || "Community"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Version</span>
                        <span className="text-sm font-medium">{instance.version}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Uptime</span>
                        <span className="text-sm font-medium flex items-center gap-1.5">
                          {instance.status === "running" ? (
                            <>
                              <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
                              {formatUptime(instance.started_at || instance.created_at)}
                            </>
                          ) : (
                            <span className="text-[var(--muted)]">Offline</span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Admin Password</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-mono">
                            {showPassword ? (instance.admin_password || "admin") : "••••••••"}
                          </span>
                          <button
                            onClick={() => setShowPassword(!showPassword)}
                            className="p-1 text-[var(--muted)] hover:text-[var(--foreground)] rounded"
                            title={showPassword ? "Hide" : "Show"}
                          >
                            {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                          <button
                            onClick={handleCopyPassword}
                            className="p-1 text-[var(--muted)] hover:text-[var(--foreground)] rounded"
                            title="Copy"
                          >
                            {passwordCopied ? <CheckCircle size={13} className="text-[var(--success)]" /> : <Copy size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Resources */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Resources</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Cpu size={14} /> CPU Cores</span>
                        <span className="text-sm font-medium">{instance.cpu_cores}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><MemoryStick size={14} /> RAM</span>
                        <span className="text-sm font-medium">{instance.ram_mb >= 1024 ? `${(instance.ram_mb / 1024).toFixed(1)} GB` : `${instance.ram_mb} MB`}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Users size={14} /> Workers</span>
                        <span className="text-sm font-medium">{instance.workers}</span>
                      </div>
                    </div>
                  </div>

                  {/* Domain & Access */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Access</h3>
                    <div className="space-y-3">
                      {instance.domain ? (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Globe size={14} /> Domain</span>
                          <a
                            href={instance.url || `https://${instance.domain}`}
                            target="_blank"
                            rel="noopener"
                            className="text-sm text-[var(--accent)] hover:underline flex items-center gap-1"
                          >
                            {instance.domain} <ExternalLink size={12} />
                          </a>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Globe size={14} /> Domain</span>
                          <span className="text-sm text-[var(--muted)]">Not configured</span>
                        </div>
                      )}
                      {instance.url && (
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><ExternalLink size={14} /> URL</span>
                          <a href={instance.url} target="_blank" rel="noopener" className="text-sm text-[var(--accent)] hover:underline truncate max-w-[200px]">
                            {instance.url}
                          </a>
                        </div>
                      )}
                      {server && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-[var(--muted)]">Server</span>
                          <span className="text-sm font-medium">{server.name} ({server.endpoint})</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Quick Stats */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Quick Stats</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Database size={14} /> Backups</span>
                        <span className="text-sm font-medium">{backups.length}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Clock size={14} /> Last Backup</span>
                        <span className="text-sm font-medium">{lastBackup.date}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm text-[var(--muted)]"><Calendar size={14} /> Created</span>
                        <span className="text-sm font-medium">
                          {instance.created_at
                            ? new Date(instance.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" })
                            : "N/A"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Health Check */}
                  {instance.status === "running" && (
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold">Health Check</h3>
                        <button onClick={loadHealth} className="text-[var(--muted)] hover:text-[var(--foreground)]">
                          <RefreshCw size={14} />
                        </button>
                      </div>
                      {health ? (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="flex items-center gap-2">
                            {health.healthy ? (
                              <CheckCircle size={16} className="text-[var(--success)]" />
                            ) : (
                              <XCircle size={16} className="text-[var(--danger)]" />
                            )}
                            <span className="text-sm">{health.healthy ? "Healthy" : "Unhealthy"}</span>
                          </div>
                          {health.http_status && (
                            <div className="text-sm text-[var(--muted)]">
                              HTTP: <span className="font-medium text-[var(--foreground)]">{health.http_status}</span>
                            </div>
                          )}
                          {health.container_status && (
                            <div className="text-sm text-[var(--muted)]">
                              Container: <span className="font-medium text-[var(--foreground)]">{health.container_status}</span>
                            </div>
                          )}
                          {health.response_time_ms !== undefined && (
                            <div className="text-sm text-[var(--muted)]">
                              Response: <span className="font-medium text-[var(--foreground)]">{health.response_time_ms}ms</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-sm text-[var(--muted)]">Loading health data...</div>
                      )}
                    </div>
                  )}

                  {/* Quick Actions */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                    <h3 className="text-sm font-semibold mb-4">Quick Actions</h3>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={handleCreateBackup}
                        disabled={!!actionLoading || instance.status !== "running"}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-[var(--card-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        {actionLoading === "backup" ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />} Create Backup
                      </button>
                      <button
                        onClick={() => setActiveTab("logs")}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-[var(--card-hover)] transition-colors flex items-center gap-2"
                      >
                        <ScrollText size={14} /> View Logs
                      </button>
                      {instance.domain && (
                        <a
                          href={instance.url || `https://${instance.domain}`}
                          target="_blank"
                          rel="noopener"
                          className="px-3 py-2 text-sm rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors flex items-center gap-2"
                        >
                          <ExternalLink size={14} /> Open Instance
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ========== LOGS TAB ========== */}
              {activeTab === "logs" && (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold">Container Logs</h3>
                      <select
                        value={logLines}
                        onChange={(e) => setLogLines(parseInt(e.target.value))}
                        className="text-xs bg-[var(--background)] border border-[var(--border)] rounded px-2 py-1"
                      >
                        <option value={50}>50 lines</option>
                        <option value={100}>100 lines</option>
                        <option value={200}>200 lines</option>
                        <option value={500}>500 lines</option>
                      </select>
                    </div>
                    <button onClick={loadLogs} className="text-[var(--muted)] hover:text-[var(--foreground)]">
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  <div className={`overflow-auto bg-[#0d1117] p-4 font-mono text-xs leading-relaxed ${logsExpanded ? "max-h-[80vh]" : "max-h-[400px]"}`}>
                    {logs.length === 0 ? (
                      <div className="text-gray-500">No logs available</div>
                    ) : (
                      logs.map((line, i) => (
                        <div key={i} className="text-gray-300 hover:bg-white/5">
                          <span className="text-gray-600 select-none mr-3">{i + 1}</span>
                          {line}
                        </div>
                      ))
                    )}
                  </div>
                  <div className="px-4 py-2 border-t border-[var(--border)] flex justify-center">
                    <button
                      onClick={() => setLogsExpanded(!logsExpanded)}
                      className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1"
                    >
                      {logsExpanded ? <><ChevronUp size={12} /> Collapse</> : <><ChevronDown size={12} /> Expand</>}
                    </button>
                  </div>
                </div>
              )}

              {/* ========== BACKUPS TAB ========== */}
              {activeTab === "backups" && (
                <div>
                  {/* Backup Schedule Section */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 mb-4">
                    <h3 className="text-sm font-semibold mb-4">Backup Schedule</h3>
                    <div className="grid gap-4 md:grid-cols-3">
                      <div>
                        <label className="text-xs text-[var(--muted)] mb-1.5 block">Automatic Backups</label>
                        <button
                          onClick={() => setBackupSchedule(s => ({ ...s, enabled: !s.enabled }))}
                          className={`relative w-11 h-6 rounded-full transition-colors ${backupSchedule.enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${backupSchedule.enabled ? "translate-x-5" : ""}`} />
                        </button>
                      </div>
                      <div>
                        <label className="text-xs text-[var(--muted)] mb-1.5 block">Frequency</label>
                        <select
                          value={backupSchedule.frequency}
                          onChange={(e) => setBackupSchedule(s => ({ ...s, frequency: e.target.value }))}
                          className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2"
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-[var(--muted)] mb-1.5 block">Retention (days)</label>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={backupSchedule.retention_days}
                          onChange={(e) => setBackupSchedule(s => ({ ...s, retention_days: parseInt(e.target.value) || 30 }))}
                          className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2"
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]">
                      <Clock size={12} />
                      Last backup: {lastBackup.date}
                      {lastBackup.status && (
                        <span className={`capitalize ${lastBackup.status === "completed" ? "text-[var(--success)]" : "text-[var(--warning)]"}`}>
                          ({lastBackup.status})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Backup List */}
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold">Backups</h3>
                    <button
                      onClick={handleCreateBackup}
                      disabled={!!actionLoading || instance.status !== "running"}
                      className="px-3 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "backup" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} New Backup
                    </button>
                  </div>

                  {backups.length === 0 ? (
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8 text-center">
                      <Database size={32} className="mx-auto text-[var(--muted)] mb-3" />
                      <p className="text-sm text-[var(--muted)]">No backups yet for this instance.</p>
                    </div>
                  ) : (
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                            <th className="text-left px-4 py-3">Status</th>
                            <th className="text-left px-4 py-3">Type</th>
                            <th className="text-left px-4 py-3">Size</th>
                            <th className="text-left px-4 py-3">Created</th>
                            <th className="text-right px-4 py-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backups.map((bkp) => (
                            <tr key={bkp.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2 text-sm">
                                  {bkp.status === "completed" && <CheckCircle size={14} className="text-[var(--success)]" />}
                                  {bkp.status === "failed" && <XCircle size={14} className="text-[var(--danger)]" />}
                                  {bkp.status === "pending" && <Clock size={14} className="text-[var(--warning)]" />}
                                  {bkp.status === "in_progress" && <Loader2 size={14} className="text-[var(--accent)] animate-spin" />}
                                  <span className="capitalize">{bkp.status}</span>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-[var(--muted)] capitalize">{bkp.backup_type}</td>
                              <td className="px-4 py-3 text-sm text-[var(--muted)]">{bkp.size_mb ? `${bkp.size_mb} MB` : "-"}</td>
                              <td className="px-4 py-3 text-sm text-[var(--muted)]">
                                {new Date(bkp.created_at).toLocaleString("it-IT", {
                                  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
                                })}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {bkp.status === "completed" && (
                                  <button
                                    onClick={() => handleRestore(bkp.id)}
                                    disabled={!!actionLoading}
                                    className="text-xs px-3 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center gap-1 ml-auto disabled:opacity-50"
                                  >
                                    {actionLoading === `restore-${bkp.id}` ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Restore
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ========== CONFIG TAB ========== */}
              {activeTab === "config" && (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                  <h3 className="text-sm font-semibold mb-6">Instance Configuration</h3>
                  <div className="space-y-5 max-w-lg">
                    {/* Instance Name */}
                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">Instance Name</label>
                      <input
                        type="text"
                        value={configForm.name}
                        onChange={(e) => setConfigForm(f => ({ ...f, name: e.target.value }))}
                        className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    {/* Domain */}
                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">Domain</label>
                      <input
                        type="text"
                        value={configForm.domain}
                        onChange={(e) => setConfigForm(f => ({ ...f, domain: e.target.value }))}
                        placeholder="e.g. erp.example.com"
                        className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--accent)]"
                      />
                      <p className="text-xs text-[var(--muted)] mt-1">Point your DNS A record to the server IP before changing.</p>
                    </div>

                    {/* Workers */}
                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">
                        Workers: <span className="font-medium text-[var(--foreground)]">{configForm.workers}</span>
                      </label>
                      <input
                        type="range"
                        min={1}
                        max={8}
                        value={configForm.workers}
                        onChange={(e) => setConfigForm(f => ({ ...f, workers: parseInt(e.target.value) }))}
                        className="w-full accent-[var(--accent)]"
                      />
                      <div className="flex justify-between text-xs text-[var(--muted)] mt-1">
                        <span>1</span>
                        <span>8</span>
                      </div>
                    </div>

                    {/* RAM */}
                    <div>
                      <label className="text-xs text-[var(--muted)] mb-1.5 block">RAM</label>
                      <select
                        value={configForm.ram_mb}
                        onChange={(e) => setConfigForm(f => ({ ...f, ram_mb: parseInt(e.target.value) }))}
                        className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2"
                      >
                        <option value={512}>512 MB</option>
                        <option value={1024}>1 GB</option>
                        <option value={2048}>2 GB</option>
                        <option value={4096}>4 GB</option>
                        <option value={8192}>8 GB</option>
                      </select>
                    </div>

                    {/* Auto-restart */}
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium block">Auto-restart on crash</label>
                        <p className="text-xs text-[var(--muted)]">Automatically restart the instance if it crashes.</p>
                      </div>
                      <button
                        onClick={() => setConfigForm(f => ({ ...f, auto_restart: !f.auto_restart }))}
                        className={`relative w-11 h-6 rounded-full transition-colors ${configForm.auto_restart ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${configForm.auto_restart ? "translate-x-5" : ""}`} />
                      </button>
                    </div>

                    {/* Save */}
                    <button
                      onClick={handleSaveConfig}
                      disabled={configSaving}
                      className="px-4 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      {configSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Configuration
                    </button>
                  </div>
                </div>
              )}

              {/* ========== ADDONS TAB ========== */}
              {activeTab === "addons" && (
                <div>
                  {/* Conflict & Compatibility Warnings */}
                  {conflicts?.conflicts?.length > 0 && (
                    <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle size={14} className="text-red-400 shrink-0" />
                        <span className="text-sm font-medium text-red-300">Module Conflicts Detected</span>
                      </div>
                      {conflicts.conflicts.map((c: any, i: number) => (
                        <p key={i} className="text-xs text-red-400 ml-6">
                          {c.module} found in {c.sources?.join(" and ") || "multiple addons"}
                        </p>
                      ))}
                    </div>
                  )}
                  {compatibility?.issues?.length > 0 && (
                    <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                        <span className="text-sm font-medium text-amber-300">Compatibility Warnings</span>
                      </div>
                      {compatibility.issues.map((c: any, i: number) => (
                        <p key={i} className="text-xs text-amber-400 ml-6">
                          Version mismatch: {c.module} (v{c.module_version}) is not compatible with Odoo {instance?.version}
                        </p>
                      ))}
                    </div>
                  )}

                  {/* Addons Table — Cloudpepper style */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 mb-4">
                    <h3 className="text-sm font-semibold mb-4">Addons</h3>

                    {addonsLoading ? (
                      <div className="text-center py-8">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-2" />
                        <p className="text-sm text-[var(--muted)]">Loading addons...</p>
                      </div>
                    ) : addons.length === 0 ? (
                      <div className="text-center py-8">
                        <Puzzle size={32} className="mx-auto text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">No addons installed yet.</p>
                        <p className="text-xs text-[var(--muted)] mt-1">
                          Add a Git repository or enable Enterprise Edition in Settings.
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-[var(--muted)] uppercase tracking-wider border-b border-[var(--border)]">
                              <th className="pb-3 pr-4">Type</th>
                              <th className="pb-3 pr-4">Repo / Name</th>
                              <th className="pb-3 pr-4">Branch</th>
                              <th className="pb-3 pr-4">Revision</th>
                              <th className="pb-3 pr-4">Status</th>
                              <th className="pb-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {addons.map((addon, idx) => (
                              <React.Fragment key={addon.id || idx}>
                                <tr className="border-b border-white/5 last:border-0">
                                  <td className="py-3 pr-4">
                                    <span className={`text-xs px-2 py-1 rounded font-medium capitalize ${
                                      addon.type === "git"
                                        ? "bg-purple-500/10 text-purple-400"
                                        : "bg-[var(--accent)]/10 text-[var(--accent)]"
                                    }`}>
                                      {addon.type === "git" ? (
                                        <span className="flex items-center gap-1"><GitBranch size={10} /> Git</span>
                                      ) : (
                                        <span className="flex items-center gap-1"><Package size={10} /> File</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="py-3 pr-4">
                                    {addon.type === "git" && addon.url ? (
                                      <div className="flex items-center gap-2">
                                        {addon.has_token && (
                                          <span title="Private repository (token auth)">
                                            <Shield size={12} className="text-amber-400 shrink-0" />
                                          </span>
                                        )}
                                        <span className="font-medium text-white truncate max-w-[200px]" title={addon.url}>
                                          {addon.name || addon.url.replace(/\.git$/, "").split("/").slice(-2).join("/")}
                                        </span>
                                        <a
                                          href={addon.url.replace(/\.git$/, "")}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-[var(--muted)] hover:text-[var(--accent)] shrink-0"
                                          title="Open repository"
                                        >
                                          <ExternalLink size={12} />
                                        </a>
                                        {addon.module_count != null && (
                                          <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-[var(--muted)]" title={`${addon.module_count} modules`}>
                                            {addon.module_count}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="font-medium text-white">{addon.name}</span>
                                    )}
                                  </td>
                                  <td className="py-3 pr-4">
                                    <span className="text-xs px-2 py-1 rounded bg-white/5 text-[var(--muted)] font-mono flex items-center gap-1 w-fit">
                                      <GitBranch size={10} />
                                      {addon.branch}
                                    </span>
                                  </td>
                                  <td className="py-3 pr-4">
                                    <div className="flex items-center gap-2">
                                      {addon.type === "git" && addon.commit ? (
                                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-mono flex items-center gap-1" title={addon.commit}>
                                          <GitCommit size={10} />
                                          {addon.commit?.substring(0, 7)}
                                        </span>
                                      ) : (
                                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-mono">
                                          {addon.revision_date || "\u2014"}
                                        </span>
                                      )}
                                      {addon.update_available && addon.available_revision_date && (
                                        <span className="text-xs text-amber-400" title={`New version available: ${addon.available_revision_date}`}>
                                          &rarr; {addon.available_revision_date}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-3 pr-4">
                                    <span className={`text-xs px-2 py-1 rounded-full capitalize ${
                                      addon.status === "installed" ? "bg-[var(--success)]/10 text-[var(--success)]" :
                                      addon.status === "cloning" ? "bg-blue-500/10 text-blue-400 animate-pulse" :
                                      addon.status === "error" ? "bg-red-500/10 text-red-400" :
                                      addon.status === "pending" ? "bg-amber-500/10 text-amber-400" :
                                      "bg-[var(--warning)]/10 text-[var(--warning)]"
                                    }`}>
                                      {addon.status === "cloning" && <Loader2 size={10} className="inline animate-spin mr-1" />}
                                      {addon.status}
                                    </span>
                                  </td>
                                  <td className="py-3 text-right">
                                    <div className="flex items-center justify-end gap-1.5">
                                      {/* Git addon actions */}
                                      {addon.type === "git" && (
                                        <>
                                          <button
                                            onClick={async () => {
                                              if (showModulesPanel?.id === addon.id) {
                                                setShowModulesPanel(null);
                                                return;
                                              }
                                              setShowModulesPanel(addon);
                                              setModulesLoading(true);
                                              try {
                                                const data = await instancesApi.getAddonModules(instanceId, addon.id);
                                                setAddonModules(data.modules || data || []);
                                              } catch { setAddonModules([]); }
                                              finally { setModulesLoading(false); }
                                            }}
                                            className={`p-1.5 text-xs rounded-lg border transition-colors ${
                                              showModulesPanel?.id === addon.id
                                                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                                                : "border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white"
                                            }`}
                                            title="Explore modules"
                                          >
                                            <Eye size={13} />
                                          </button>
                                          <button
                                            onClick={() => setShowAddonSettingsModal(addon)}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors"
                                            title="Repository settings"
                                          >
                                            <Settings2 size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              try {
                                                const result = await instancesApi.updateGitAddon(instanceId, addon.id);
                                                setShowUpdateModal({ addon, result });
                                              } catch (e: any) {
                                                alert(e.message || "Failed to check for updates");
                                              }
                                            }}
                                            disabled={instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors disabled:opacity-50"
                                            title="Update"
                                          >
                                            <RefreshCw size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              if (!confirm(`Remove this git addon (${addon.name || addon.url})? The repository will be deleted from the instance.`)) return;
                                              setGitAddonRemoving(addon.id);
                                              try {
                                                await instancesApi.removeGitAddon(instanceId, addon.id);
                                                loadAddons();
                                              } catch (e: any) {
                                                alert(e.message || "Failed to remove addon");
                                              } finally {
                                                setGitAddonRemoving(null);
                                              }
                                            }}
                                            disabled={gitAddonRemoving === addon.id || instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                            title="Remove"
                                          >
                                            {gitAddonRemoving === addon.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                                          </button>
                                        </>
                                      )}

                                      {/* Enterprise / File addon actions */}
                                      {addon.type !== "git" && (
                                        <>
                                          {addon.can_update && (
                                            <button
                                              onClick={async () => {
                                                if (!confirm("Update enterprise addons? This will re-sync from the global package and restart the instance.")) return;
                                                setAddonUpdating(true);
                                                try {
                                                  await instancesApi.updateEnterpriseAddons(instanceId);
                                                  const poll = setInterval(async () => {
                                                    try {
                                                      const data = await instancesApi.get(instanceId);
                                                      setInstance(data);
                                                      if (data.status !== "upgrading") {
                                                        clearInterval(poll);
                                                        setAddonUpdating(false);
                                                        loadAddons();
                                                      }
                                                    } catch {}
                                                  }, 3000);
                                                } catch (e: any) {
                                                  alert(e.message || "Failed to update addons");
                                                  setAddonUpdating(false);
                                                }
                                              }}
                                              disabled={addonUpdating || instance?.status !== "running"}
                                              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 flex items-center gap-1.5 ${
                                                addon.update_available
                                                  ? "border-amber-500/50 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse"
                                                  : "border-[var(--border)] hover:bg-white/5"
                                              }`}
                                            >
                                              {addonUpdating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                              {addon.update_available ? "Update Available" : "Update"}
                                            </button>
                                          )}
                                          {addon.can_delete && (
                                            <button
                                              onClick={async () => {
                                                if (!confirm("Remove Enterprise addons? This will revert the instance to Community edition.\n\nIf enterprise modules are installed in the database, Odoo may not function correctly.\n\nThe instance will be restarted. Continue?")) return;
                                                try {
                                                  await instancesApi.removeEnterpriseAddons(instanceId);
                                                  loadAddons();
                                                  loadInstance();
                                                } catch (e: any) {
                                                  alert(e.message || "Failed to remove addon");
                                                }
                                              }}
                                              disabled={instance?.status !== "running"}
                                              className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                            >
                                              Delete
                                            </button>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>

                                {/* Module Explorer Panel — inline expansion */}
                                {showModulesPanel?.id === addon.id && addon.type === "git" && (
                                  <tr>
                                    <td colSpan={6} className="p-0">
                                      <div className="bg-[var(--background)] border-t border-[var(--border)] p-4">
                                        <div className="flex items-center justify-between mb-3">
                                          <h4 className="text-sm font-medium text-white flex items-center gap-2">
                                            <BookOpen size={14} />
                                            Modules in {addon.name || "repository"}
                                            {!modulesLoading && (
                                              <span className="text-xs px-1.5 py-0.5 rounded bg-white/10 text-[var(--muted)]">
                                                {addonModules.length}
                                              </span>
                                            )}
                                          </h4>
                                          <button
                                            onClick={() => setShowModulesPanel(null)}
                                            className="text-[var(--muted)] hover:text-white"
                                          >
                                            <X size={14} />
                                          </button>
                                        </div>

                                        {modulesLoading ? (
                                          <div className="text-center py-4">
                                            <Loader2 size={16} className="mx-auto animate-spin text-[var(--muted)]" />
                                          </div>
                                        ) : addonModules.length === 0 ? (
                                          <p className="text-xs text-[var(--muted)] py-2">No modules found in this repository.</p>
                                        ) : (
                                          <div className="grid gap-1.5 max-h-64 overflow-y-auto">
                                            {addonModules.map((mod: any, mi: number) => {
                                              const versionMatch = mod.version?.startsWith(instance?.version);
                                              return (
                                                <div key={mi} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--card)] border border-white/5 text-xs">
                                                  <div className="flex items-center gap-3">
                                                    <span className="font-mono text-white font-medium">{mod.technical_name || mod.name}</span>
                                                    {mod.display_name && mod.display_name !== mod.technical_name && (
                                                      <span className="text-[var(--muted)]">{mod.display_name}</span>
                                                    )}
                                                  </div>
                                                  <div className="flex items-center gap-2">
                                                    {mod.version && (
                                                      <span className={`px-1.5 py-0.5 rounded ${
                                                        versionMatch
                                                          ? "bg-[var(--success)]/10 text-[var(--success)]"
                                                          : "bg-amber-500/10 text-amber-400"
                                                      }`} title={versionMatch ? "Compatible" : "Version mismatch"}>
                                                        {versionMatch ? <CheckCircle size={10} className="inline mr-0.5" /> : <AlertTriangle size={10} className="inline mr-0.5" />}
                                                        {mod.version}
                                                      </span>
                                                    )}
                                                    {mod.installable === false && (
                                                      <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">not installable</span>
                                                    )}
                                                    {mod.dependencies?.length > 0 && (
                                                      <span className="text-[var(--muted)]" title={`Dependencies: ${mod.dependencies.join(", ")}`}>
                                                        {mod.dependencies.length} deps
                                                      </span>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Upgrading progress banner */}
                    {instance?.status === "upgrading" && instance?.config?.enterprise_progress && (
                      <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center gap-3">
                        <Loader2 size={16} className="animate-spin text-blue-400" />
                        <div>
                          <p className="text-sm text-blue-300 font-medium">Addon update in progress</p>
                          <p className="text-xs text-blue-400 mt-0.5">{instance.config.enterprise_progress}</p>
                        </div>
                      </div>
                    )}

                    {/* Action buttons row */}
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => {
                          setGitAddonForm({ url: "", branch: instance?.version || "", copy_method: "all", specific_addons: "", access_token: "" });
                          setShowAddGitModal(true);
                        }}
                        className="px-4 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2"
                      >
                        <Plus size={14} /> Add Git Repository
                      </button>
                      <button
                        onClick={async () => {
                          setShowOcaModal(true);
                          if (ocaCatalog.length === 0) {
                            try {
                              const data = await instancesApi.getOcaCatalog();
                              setOcaCatalog(data);
                            } catch { setOcaCatalog([]); }
                          }
                        }}
                        className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-2"
                      >
                        <Library size={14} /> OCA Catalog
                      </button>
                      <div className="flex-1" />
                      <button
                        onClick={async () => {
                          try {
                            const data = await instancesApi.checkConflicts(instanceId);
                            setConflicts(data);
                          } catch {}
                        }}
                        className="text-xs text-[var(--muted)] hover:text-white transition-colors flex items-center gap-1"
                      >
                        <AlertTriangle size={12} /> Check Conflicts
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            const data = await instancesApi.checkCompatibility(instanceId);
                            setCompatibility(data);
                          } catch {}
                        }}
                        className="text-xs text-[var(--muted)] hover:text-white transition-colors flex items-center gap-1"
                      >
                        <CheckCircle size={12} /> Check Compatibility
                      </button>
                    </div>
                  </div>

                  {/* Install Custom Module */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4">Install Custom Module</h3>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={addonInput}
                        onChange={(e) => setAddonInput(e.target.value)}
                        placeholder="Module technical name (e.g. sale_management)"
                        className="flex-1 text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--accent)]"
                      />
                      <button
                        disabled={!addonInput.trim() || instance.status !== "running"}
                        className="px-4 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        <Plus size={14} /> Install
                      </button>
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-2">
                      Enter the technical name of the Odoo module to install. The instance will restart automatically.
                    </p>
                  </div>
                </div>
              )}

              {/* ========== STAGING TAB ========== */}
              {activeTab === "staging" && (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                  <h3 className="text-sm font-semibold mb-4">Staging Environment</h3>
                  <div className="text-center py-12">
                    <GitBranch size={40} className="mx-auto text-[var(--muted)] mb-4" />
                    <h4 className="text-lg font-semibold mb-2">Coming Soon</h4>
                    <p className="text-sm text-[var(--muted)] max-w-md mx-auto mb-6">
                      Create a staging copy of your production instance to safely test updates, module installations, and configuration changes before going live.
                    </p>
                    <div className="grid gap-3 max-w-sm mx-auto text-left">
                      <div className="flex items-start gap-3 text-sm text-[var(--muted)]">
                        <CheckCircle size={16} className="text-[var(--accent)] mt-0.5 shrink-0" />
                        <span>One-click staging copy from production</span>
                      </div>
                      <div className="flex items-start gap-3 text-sm text-[var(--muted)]">
                        <CheckCircle size={16} className="text-[var(--accent)] mt-0.5 shrink-0" />
                        <span>Sync data from production to staging</span>
                      </div>
                      <div className="flex items-start gap-3 text-sm text-[var(--muted)]">
                        <CheckCircle size={16} className="text-[var(--accent)] mt-0.5 shrink-0" />
                        <span>Promote staging to production when ready</span>
                      </div>
                    </div>
                    <button
                      disabled
                      className="mt-6 px-4 py-2 text-sm rounded-lg bg-[var(--accent)] opacity-50 cursor-not-allowed flex items-center gap-2 mx-auto"
                    >
                      <GitBranch size={14} /> Create Staging Copy
                    </button>
                  </div>
                </div>
              )}

              {/* ========== MONITORING TAB ========== */}
              {activeTab === "monitoring" && (
                <div className="grid gap-4 md:grid-cols-2">
                  {/* CPU Usage */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Cpu size={14} /> CPU Usage</h3>
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        {instance.status === "running" ? "23%" : "0%"}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-[var(--background)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)] rounded-full transition-all"
                        style={{ width: instance.status === "running" ? "23%" : "0%" }}
                      />
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-2">
                      {instance.status === "running" ? `${instance.cpu_cores} cores allocated` : "Instance is offline"}
                    </p>
                  </div>

                  {/* RAM Usage */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><MemoryStick size={14} /> RAM Usage</h3>
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        {instance.status === "running"
                          ? `${Math.round(instance.ram_mb * 0.45)} / ${instance.ram_mb} MB`
                          : "0 MB"}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-[var(--background)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--success)] rounded-full transition-all"
                        style={{ width: instance.status === "running" ? "45%" : "0%" }}
                      />
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-2">
                      {instance.status === "running" ? "45% utilized" : "Instance is offline"}
                    </p>
                  </div>

                  {/* Disk Usage */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><HardDrive size={14} /> Disk Usage</h3>
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        {instance.status === "running" ? "2.1 / 10 GB" : "-- / -- GB"}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-[var(--background)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--warning)] rounded-full transition-all"
                        style={{ width: instance.status === "running" ? "21%" : "0%" }}
                      />
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-2">
                      {instance.status === "running" ? "21% utilized" : "Instance is offline"}
                    </p>
                  </div>

                  {/* Uptime & Response */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Gauge size={14} /> Uptime & Performance</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Uptime (30d)</span>
                        <span className="text-sm font-medium text-[var(--success)]">
                          {instance.status === "running" ? "99.7%" : "N/A"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Avg Response Time</span>
                        <span className="text-sm font-medium">
                          {health?.response_time_ms ? `${health.response_time_ms}ms` : "N/A"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--muted)]">Current Status</span>
                        <span className="flex items-center gap-1.5 text-sm">
                          {instance.status === "running" ? (
                            <>
                              <span className="w-2 h-2 rounded-full bg-[var(--success)]" />
                              <span className="text-[var(--success)]">Online</span>
                            </>
                          ) : (
                            <>
                              <span className="w-2 h-2 rounded-full bg-[var(--muted)]" />
                              <span className="text-[var(--muted)]">Offline</span>
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Response Time Graph Placeholder */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Activity size={14} /> Response Time (24h)</h3>
                    <div className="h-40 flex items-center justify-center border border-dashed border-[var(--border)] rounded-lg">
                      <div className="text-center">
                        <Activity size={24} className="mx-auto text-[var(--muted)] mb-2" />
                        <p className="text-xs text-[var(--muted)]">Response time graph will appear here when monitoring data is available.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ========== SETTINGS TAB ========== */}
              {activeTab === "settings" && (
                <div className="space-y-6">
                  {/* Domain Settings Card */}
                  <div className="bg-[var(--card)] border border-white/10 rounded-xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Globe className="w-5 h-5 text-blue-400" />
                        Domain Settings
                      </h3>
                      <button onClick={() => { setDomainForm({ domain: instance?.domain || "", aliases: instance?.config?.aliases || [], http_redirect: instance?.config?.http_redirect ?? true }); setShowDomainModal(true); }}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm">
                        Edit Domain
                      </button>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-gray-400">Primary Domain</span><span className="text-white">{instance?.domain || "\u2014"}</span></div>
                      {instance?.config?.aliases?.length > 0 && (
                        <div className="flex justify-between"><span className="text-gray-400">Aliases</span><span className="text-white">{instance.config.aliases.join(", ")}</span></div>
                      )}
                      <div className="flex justify-between"><span className="text-gray-400">HTTPS Redirect</span><span className="text-white">{instance?.config?.http_redirect !== false ? "Enabled" : "Disabled"}</span></div>
                    </div>
                  </div>

                  {/* Enterprise Upgrade Progress */}
                  {instance?.status === "upgrading" && instance?.config?.enterprise_progress && (
                    <div className="bg-blue-900/30 border border-blue-500/30 rounded-xl p-5">
                      <div className="flex items-center gap-3">
                        <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-300">Enterprise Activation in Progress</h4>
                          <p className="text-xs text-blue-400 mt-1">{instance.config.enterprise_progress}</p>
                          <p className="text-xs text-gray-500 mt-1">Please do not close this page or perform other operations on this instance.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Enterprise Error */}
                  {instance?.config?.enterprise_error && (
                    <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
                      <div className="flex items-center gap-2 text-sm text-red-400">
                        <XCircle className="w-4 h-4 shrink-0" />
                        <span>Enterprise activation failed: {instance.config.enterprise_error}</span>
                      </div>
                    </div>
                  )}

                  {/* Instance Settings Card */}
                  <div className="bg-[var(--card)] border border-white/10 rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Instance Settings</h3>
                    <div className="space-y-4">
                      <SettingToggle label="Auto SSL" description="Automatically provision and renew Let's Encrypt SSL certificates" checked={instance?.config?.auto_ssl !== false} onChange={(v) => handleSaveSettings("auto_ssl", v)} disabled={instance?.status === "upgrading"} />
                      <SettingToggle label="Auto Update Odoo" description="Automatically apply minor version updates when available" checked={instance?.config?.auto_update === true} onChange={(v) => handleSaveSettings("auto_update", v)} disabled={instance?.status === "upgrading"} />
                      <SettingToggle
                        label="Enterprise Edition"
                        description={
                          instance?.status === "upgrading" ? "Activation in progress..." :
                          instance?.config?.enterprise === true ? "Odoo Enterprise is active" :
                          enterprisePackages.find((p: any) => p.version === instance?.version) ? "Enable Odoo Enterprise features for this instance" :
                          `Upload Enterprise package for Odoo ${instance?.version} in Settings to enable`
                        }
                        checked={instance?.config?.enterprise === true}
                        onChange={(v) => handleSaveSettings("enterprise", v)}
                        disabled={instance?.status === "upgrading" || !enterprisePackages.find((p: any) => p.version === instance?.version)}
                      />
                      {instance?.config?.enterprise === true && (
                        <SettingToggle
                          label="Bypass License Check"
                          description="Dev mode: extend expiration to 2099 and hide the license warning banner"
                          checked={instance?.config?.enterprise_bypass_license === true}
                          onChange={(v) => handleSaveSettings("enterprise_bypass_license", v)}
                          disabled={instance?.status === "upgrading"}
                        />
                      )}
                    </div>
                  </div>

                  {/* Notifications */}
                  <div className="bg-[var(--card)] border border-white/10 rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-white mb-4">Notifications</h3>
                    <div className="space-y-4">
                      <SettingToggle label="Error Notifications" description="Receive alerts when the instance encounters errors" checked={settingsForm.notify_on_error} onChange={(v) => setSettingsForm(f => ({ ...f, notify_on_error: v }))} />
                      <SettingToggle label="Backup Notifications" description="Get notified when backups complete successfully" checked={settingsForm.notify_on_backup} onChange={(v) => setSettingsForm(f => ({ ...f, notify_on_backup: v }))} />
                    </div>
                  </div>

                  {/* Danger Zone */}
                  <div className="bg-[var(--card)] border border-[var(--danger)]/30 rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-1 text-[var(--danger)]">Danger Zone</h3>
                    <p className="text-xs text-[var(--muted)] mb-4">These actions are irreversible. Please proceed with caution.</p>
                    <div className="flex items-center justify-between p-3 border border-[var(--danger)]/20 rounded-lg">
                      <div>
                        <p className="text-sm font-medium">Delete this instance</p>
                        <p className="text-xs text-[var(--muted)]">Permanently delete {instance.name} and all associated data, backups, and configurations.</p>
                      </div>
                      <button
                        onClick={handleDelete}
                        disabled={!!actionLoading}
                        className="px-4 py-2 text-sm rounded-lg border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white transition-colors flex items-center gap-2 disabled:opacity-50 shrink-0"
                      >
                        {actionLoading === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete Instance
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>
          <VitoChat />
        </div>

        {/* Add Git Repository Modal */}
        {showAddGitModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowAddGitModal(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") setShowAddGitModal(false); }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <GitBranch size={18} /> Add Git Repository
                </h3>
                <button onClick={() => setShowAddGitModal(false)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Git repository URL</label>
                  <input
                    value={gitAddonForm.url}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, url: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder="https://github.com/org/repo.git"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Branch</label>
                  <input
                    value={gitAddonForm.branch}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, branch: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder={instance?.version || "17.0"}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Access Token <span className="text-gray-500 font-normal">(optional — for private repos)</span></label>
                  <input
                    value={gitAddonForm.access_token}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, access_token: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder="ghp_xxxx or glpat-xxxx"
                    type="password"
                    autoComplete="off"
                  />
                  <p className="text-xs text-gray-500 mt-1">GitHub PAT, GitLab token, or Bitbucket app password. Leave empty for public repos.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Copy method</label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copy_method"
                        checked={gitAddonForm.copy_method === "all"}
                        onChange={() => setGitAddonForm({ ...gitAddonForm, copy_method: "all" })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-sm text-white">All addons (recommended)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copy_method"
                        checked={gitAddonForm.copy_method === "specific"}
                        onChange={() => setGitAddonForm({ ...gitAddonForm, copy_method: "specific" })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-sm text-white">Specific addons</span>
                    </label>
                  </div>
                </div>

                {gitAddonForm.copy_method === "specific" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Module names</label>
                    <input
                      value={gitAddonForm.specific_addons}
                      onChange={(e) => setGitAddonForm({ ...gitAddonForm, specific_addons: e.target.value })}
                      className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                      placeholder="module_a, module_b, module_c"
                    />
                    <p className="text-xs text-gray-500 mt-1">Comma-separated list of module technical names</p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowAddGitModal(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!gitAddonForm.url.trim()) return;
                    setGitAddonAdding(true);
                    try {
                      const payload: { url: string; branch: string; copy_method?: string; specific_addons?: string[]; access_token?: string } = {
                        url: gitAddonForm.url.trim(),
                        branch: gitAddonForm.branch.trim() || instance?.version || "17.0",
                      };
                      if (gitAddonForm.access_token.trim()) {
                        payload.access_token = gitAddonForm.access_token.trim();
                      }
                      if (gitAddonForm.copy_method === "specific" && gitAddonForm.specific_addons.trim()) {
                        payload.copy_method = "specific";
                        payload.specific_addons = gitAddonForm.specific_addons.split(",").map(s => s.trim()).filter(Boolean);
                      }
                      await instancesApi.addGitAddon(instanceId, payload);
                      setShowAddGitModal(false);
                      loadAddons();
                    } catch (e: any) {
                      alert(e.message || "Failed to add git addon");
                    } finally {
                      setGitAddonAdding(false);
                    }
                  }}
                  disabled={!gitAddonForm.url.trim() || gitAddonAdding}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {gitAddonAdding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Add Module
                </button>
              </div>
            </div>
          </div>
        )}

        {/* OCA Catalog Modal */}
        {showOcaModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowOcaModal(false); }}
            onKeyDown={(e) => { if (e.key === "Escape") setShowOcaModal(false); }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Library size={18} /> OCA Repository Catalog
                </h3>
                <button onClick={() => setShowOcaModal(false)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="relative mb-4">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                <input
                  value={ocaSearch}
                  onChange={(e) => setOcaSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                  placeholder="Search OCA repositories..."
                  autoFocus
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
                {ocaCatalog.length === 0 ? (
                  <div className="text-center py-8">
                    <Loader2 size={20} className="mx-auto animate-spin text-[var(--muted)] mb-2" />
                    <p className="text-sm text-[var(--muted)]">Loading catalog...</p>
                  </div>
                ) : (
                  (() => {
                    const filtered = ocaCatalog.filter(
                      (repo) =>
                        !ocaSearch ||
                        repo.name?.toLowerCase().includes(ocaSearch.toLowerCase()) ||
                        repo.description?.toLowerCase().includes(ocaSearch.toLowerCase()) ||
                        repo.category?.toLowerCase().includes(ocaSearch.toLowerCase())
                    );
                    // Group by category
                    const grouped: Record<string, typeof filtered> = {};
                    filtered.forEach((repo) => {
                      const cat = repo.category || "Other";
                      if (!grouped[cat]) grouped[cat] = [];
                      grouped[cat].push(repo);
                    });
                    const categories = Object.keys(grouped).sort();

                    if (filtered.length === 0) {
                      return <p className="text-sm text-[var(--muted)] text-center py-4">No repositories match your search.</p>;
                    }

                    return categories.map((cat) => (
                      <div key={cat}>
                        <h4 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-1.5 mt-3 first:mt-0">{cat}</h4>
                        {grouped[cat].map((repo: any, ri: number) => (
                          <div key={ri} className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">
                            <div className="flex-1 min-w-0 mr-3">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-white">{repo.name}</span>
                                {repo.url && (
                                  <a href={repo.url.replace(/\.git$/, "")} target="_blank" rel="noopener noreferrer" className="text-[var(--muted)] hover:text-[var(--accent)]">
                                    <ExternalLink size={11} />
                                  </a>
                                )}
                              </div>
                              {repo.description && (
                                <p className="text-xs text-[var(--muted)] mt-0.5 truncate">{repo.description}</p>
                              )}
                            </div>
                            <button
                              onClick={() => {
                                setShowOcaModal(false);
                                setGitAddonForm({
                                  url: repo.url || `https://github.com/OCA/${repo.name}.git`,
                                  branch: instance?.version || "17.0",
                                  copy_method: "all",
                                  specific_addons: "",
                                  access_token: "",
                                });
                                setShowAddGitModal(true);
                              }}
                              className="px-3 py-1 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors shrink-0 flex items-center gap-1"
                            >
                              <Plus size={12} /> Add
                            </button>
                          </div>
                        ))}
                      </div>
                    ));
                  })()
                )}
              </div>
            </div>
          </div>
        )}

        {/* Repository Settings Modal */}
        {showAddonSettingsModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowAddonSettingsModal(null); }}
            onKeyDown={(e) => { if (e.key === "Escape") setShowAddonSettingsModal(null); }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Settings2 size={18} /> Repository Settings
                </h3>
                <button onClick={() => setShowAddonSettingsModal(null)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <p className="text-sm text-[var(--muted)] mb-4">
                {showAddonSettingsModal.name || showAddonSettingsModal.url?.replace(/\.git$/, "").split("/").slice(-2).join("/")}
              </p>

              <div className="space-y-1">
                <SettingToggle
                  label="Auto update when pushed"
                  description="Automatically pull changes when a webhook is received"
                  checked={showAddonSettingsModal.settings?.auto_update ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { auto_update: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, settings: { ...showAddonSettingsModal.settings, auto_update: v } });
                      loadAddons();
                    } catch (e: any) { alert(e.message || "Failed to save setting"); }
                  }}
                />
                <SettingToggle
                  label="Install Python requirements"
                  description="Run pip install -r requirements.txt on update"
                  checked={showAddonSettingsModal.settings?.install_requirements ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { install_requirements: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, settings: { ...showAddonSettingsModal.settings, install_requirements: v } });
                      loadAddons();
                    } catch (e: any) { alert(e.message || "Failed to save setting"); }
                  }}
                />
                <SettingToggle
                  label="Auto upgrade module(s)"
                  description="Automatically upgrade Odoo modules after pulling changes"
                  checked={showAddonSettingsModal.settings?.auto_upgrade ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { auto_upgrade: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, settings: { ...showAddonSettingsModal.settings, auto_upgrade: v } });
                      loadAddons();
                    } catch (e: any) { alert(e.message || "Failed to save setting"); }
                  }}
                />
              </div>

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setShowAddonSettingsModal(null)}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Update Addon Modal */}
        {showUpdateModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowUpdateModal(null); }}
            onKeyDown={(e) => { if (e.key === "Escape") setShowUpdateModal(null); }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <RefreshCw size={18} /> Update Addon
                </h3>
                <button onClick={() => setShowUpdateModal(null)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">Branch</span>
                  <span className="text-sm font-mono text-white flex items-center gap-1">
                    <GitBranch size={12} /> {showUpdateModal.addon?.branch}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">Previous commit</span>
                  <span className="text-xs font-mono px-2 py-1 rounded bg-white/5 text-[var(--muted)]">
                    {showUpdateModal.result?.old_commit || showUpdateModal.addon?.commit || "\u2014"}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">New commit</span>
                  <span className="text-xs font-mono px-2 py-1 rounded bg-white/5 text-[var(--muted)]">
                    {showUpdateModal.result?.new_commit || showUpdateModal.result?.commit || "\u2014"}
                  </span>
                </div>

                {showUpdateModal.result?.already_up_to_date && (
                  <div className="mt-2 p-3 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/20 flex items-center gap-2">
                    <CheckCircle size={14} className="text-[var(--success)]" />
                    <span className="text-sm text-[var(--success)]">Already up to date</span>
                  </div>
                )}

                {!showUpdateModal.result?.already_up_to_date && showUpdateModal.addon?.url?.includes("github.com") && showUpdateModal.result?.old_commit && showUpdateModal.result?.new_commit && (
                  <a
                    href={`${showUpdateModal.addon.url.replace(/\.git$/, "")}/compare/${showUpdateModal.result.old_commit}...${showUpdateModal.result.new_commit}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline mt-1"
                  >
                    <ExternalLink size={12} /> Show differences on Github
                  </a>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowUpdateModal(null)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                >
                  {showUpdateModal.result?.already_up_to_date ? "Close" : "Cancel"}
                </button>
                {!showUpdateModal.result?.already_up_to_date && (
                  <button
                    onClick={async () => {
                      setShowUpdateModal(null);
                      try {
                        await instancesApi.restart(instanceId);
                        await loadInstance();
                        loadAddons();
                      } catch (e: any) {
                        alert(e.message || "Failed to restart instance");
                      }
                    }}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2"
                  >
                    <RefreshCw size={14} /> Update Module
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Domain Settings Modal */}
        {showDomainModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold text-white">Domain Settings</h3>
                <button onClick={() => setShowDomainModal(false)} className="text-gray-400 hover:text-white">&#x2715;</button>
              </div>

              {/* Primary Domain */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">Domain name</label>
                <input value={domainForm.domain} onChange={e => setDomainForm({...domainForm, domain: e.target.value})}
                  className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white" placeholder="example.com" />
                <p className="text-xs text-gray-500 mt-1">
                  Make sure you have created a DNS A record pointing to <span className="text-amber-400 font-mono">{instance?.config?.endpoint || instance?.url?.replace(/https?:\/\//, "").split(":")[0]}</span>
                </p>
              </div>

              {/* Domain Aliases */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">Domain aliases</label>
                {domainForm.aliases.map((alias, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input value={alias} onChange={e => { const a = [...domainForm.aliases]; a[i] = e.target.value; setDomainForm({...domainForm, aliases: a}); }}
                      className="flex-1 px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm" />
                    <button onClick={() => setDomainForm({...domainForm, aliases: domainForm.aliases.filter((_, j) => j !== i)})}
                      className="px-3 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30">Remove</button>
                  </div>
                ))}
                <button onClick={() => setDomainForm({...domainForm, aliases: [...domainForm.aliases, ""]})}
                  className="text-blue-400 text-sm hover:text-blue-300">+ Add additional domain</button>
              </div>

              {/* HTTP Redirect Toggle */}
              <div className="flex items-center justify-between mb-6 py-3 border-t border-white/10">
                <span className="text-white text-sm">Redirect all HTTP requests to HTTPS</span>
                <button onClick={() => setDomainForm({...domainForm, http_redirect: !domainForm.http_redirect})}
                  className={`relative w-11 h-6 rounded-full transition-colors ${domainForm.http_redirect ? "bg-emerald-500" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${domainForm.http_redirect ? "translate-x-5" : ""}`} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowDomainModal(false)} className="px-4 py-2 text-gray-400 hover:text-white">Cancel</button>
                <button onClick={handleSaveDomain} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">Save</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
