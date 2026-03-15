"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { serversApi, instancesApi } from "@/lib/api";
import { LogViewer } from "@/components/dashboard/LogViewer";
import { MonitoringCharts } from "@/components/dashboard/MonitoringCharts";
import { SecurityScanner } from "@/components/dashboard/SecurityScanner";
import { Fail2banManager } from "@/components/dashboard/Fail2banManager";
import { SslManager } from "@/components/dashboard/SslManager";
import {
  ArrowLeft, Cpu, MemoryStick, HardDrive, Trash2, RefreshCw,
  Loader2, CheckCircle, XCircle, AlertTriangle, Clock,
  LayoutDashboard, Activity, Server, Box, Shield, Database,
  Terminal, Key, Settings2, ScrollText, Play, Square, RotateCcw,
  Plus, ChevronDown, ChevronUp, Globe, Eye, EyeOff, Copy,
  Wifi, WifiOff, Gauge, Zap, Network, Power, X,
  ShieldCheck, ShieldAlert, Lock, Unlock, Ban,
  Calendar, Timer, ExternalLink, MapPin,
  ArrowUpCircle, Container, Globe2, Wrench, TrendingUp, FileCode
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

type TabId = "dashboard" | "monitoring" | "instances" | "services" | "security" | "postgresql" | "cron" | "logs" | "sshkeys" | "settings" | "upgrade" | "nginx" | "docker" | "network";

interface TabDef { id: TabId; label: string; icon: typeof LayoutDashboard }
interface TabGroup { label: string; tabs: TabDef[] }

function getTabGroups(t: (k: string) => string): TabGroup[] {
  return [
    {
      label: t("tabGroupOverview"),
      tabs: [
        { id: "dashboard", label: t("tabDashboard"), icon: LayoutDashboard },
        { id: "monitoring", label: t("tabMonitoring"), icon: Activity },
        { id: "instances", label: t("tabInstances"), icon: Box },
      ],
    },
    {
      label: t("tabGroupInfra"),
      tabs: [
        { id: "docker", label: t("tabDocker"), icon: Container },
        { id: "nginx", label: t("tabNginx"), icon: FileCode },
        { id: "services", label: t("tabServices"), icon: Server },
      ],
    },
    {
      label: t("tabGroupSecurity"),
      tabs: [
        { id: "security", label: t("tabSecurity"), icon: Shield },
        { id: "network", label: t("tabNetwork"), icon: Globe2 },
      ],
    },
    {
      label: t("tabGroupDatabase"),
      tabs: [
        { id: "postgresql", label: t("tabPostgreSQL"), icon: Database },
        { id: "cron", label: t("tabCronJobs"), icon: Calendar },
      ],
    },
    {
      label: t("tabGroupSystem"),
      tabs: [
        { id: "logs", label: t("tabLogs"), icon: ScrollText },
        { id: "sshkeys", label: t("tabSSHKeys"), icon: Key },
        { id: "settings", label: t("tabSettings"), icon: Settings2 },
        { id: "upgrade", label: t("tabUpgrade"), icon: ArrowUpCircle },
      ],
    },
  ];
}

const statusColors: Record<string, string> = {
  online: "text-[var(--success)]",
  offline: "text-[var(--danger)]",
  provisioning: "text-[var(--warning)]",
  error: "text-[var(--danger)]",
};

const statusBg: Record<string, string> = {
  online: "bg-[var(--success)]",
  offline: "bg-[var(--danger)]",
  provisioning: "bg-[var(--warning)]",
  error: "bg-[var(--danger)]",
};

// ─── Progress Bar ──────────────────────────────────────────────────

function ProgressBar({ value, max = 100, color = "var(--accent)", label, sublabel }: {
  value: number; max?: number; color?: string; label?: string; sublabel?: string;
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const barColor = pct > 90 ? "var(--danger)" : pct > 70 ? "var(--warning)" : color;
  return (
    <div>
      {(label || sublabel) && (
        <div className="flex justify-between text-xs mb-1">
          {label && <span className="text-[var(--foreground)] font-medium">{label}</span>}
          {sublabel && <span className="text-[var(--muted)]">{sublabel}</span>}
        </div>
      )}
      <div className="w-full h-2.5 bg-[var(--border)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: barColor }} />
      </div>
    </div>
  );
}

// ─── Metric Card ───────────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, sublabel, color }: {
  icon: typeof Cpu; label: string; value: string | number; sublabel?: string; color?: string;
}) {
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className="text-[var(--muted)]" />
        <span className="text-xs text-[var(--muted)] uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color || "text-[var(--foreground)]"}`}>{value}</div>
      {sublabel && <div className="text-xs text-[var(--muted)] mt-1">{sublabel}</div>}
    </div>
  );
}

// ─── Toggle Component ──────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-emerald-500" : "bg-gray-600"} ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

// ─── Confirmation Modal ────────────────────────────────────────────

function ConfirmModal({ title, message, onConfirm, onCancel, danger, loading }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void; danger?: boolean; loading?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-md w-full">
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-2">{title}</h3>
        <p className="text-sm text-[var(--muted)] mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 text-sm rounded-lg text-white flex items-center gap-2 ${danger ? "bg-red-600 hover:bg-red-700" : "bg-[var(--accent)] hover:opacity-90"}`}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ─────────────────────────────────────────────────────────

function Toast({ message, type, onDismiss }: { message: string; type: "success" | "error"; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-xl flex items-center gap-2 text-sm text-white ${type === "success" ? "bg-emerald-600" : "bg-red-600"}`}>
      {type === "success" ? <CheckCircle size={16} /> : <XCircle size={16} />}
      {message}
      <button onClick={onDismiss} className="ml-2 hover:opacity-80"><X size={14} /></button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════

export default function ServerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations("serverDetail");
  const tCommon = useTranslations("common");
  const serverId = params.id as string;

  const ALL_TAB_GROUPS = useMemo(() => getTabGroups(t), [t]);

  // ─── Core state ────────────────────────────────────────────────
  const [server, setServer] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; action: () => void; danger?: boolean } | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  // ─── Tab-specific state ────────────────────────────────────────
  // Monitoring
  const [detailedMetrics, setDetailedMetrics] = useState<any>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Instances
  const [instances, setInstances] = useState<any[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);

  // Services
  const [services, setServices] = useState<any[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);

  // Hide tabs for services not installed on this server
  const hiddenTabs = useMemo<Set<TabId>>(() => {
    const hidden = new Set<TabId>();
    if (services.length > 0) {
      const pg = services.find((s: any) => s.name === "postgresql");
      if (pg && !pg.installed) hidden.add("postgresql");
      const nginx = services.find((s: any) => s.name === "nginx");
      if (nginx && !nginx.installed) hidden.add("nginx");
      const docker = services.find((s: any) => s.name === "docker");
      if (docker && !docker.installed) hidden.add("docker");
    }
    return hidden;
  }, [services]);

  const TAB_GROUPS = useMemo(() => {
    return ALL_TAB_GROUPS
      .map(g => ({ ...g, tabs: g.tabs.filter(tab => !hiddenTabs.has(tab.id)) }))
      .filter(g => g.tabs.length > 0);
  }, [ALL_TAB_GROUPS, hiddenTabs]);

  const TABS = useMemo(() => TAB_GROUPS.flatMap(g => g.tabs), [TAB_GROUPS]);

  // Security
  const [securityAudit, setSecurityAudit] = useState<any>(null);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [firewallData, setFirewallData] = useState<any>(null);
  const [firewallLoading, setFirewallLoading] = useState(false);
  const [showAddRuleModal, setShowAddRuleModal] = useState(false);
  const [ruleForm, setRuleForm] = useState({ port: "", protocol: "tcp", source: "", action: "allow", comment: "" });

  // PostgreSQL
  const [databases, setDatabases] = useState<any[]>([]);
  const [pgConfig, setPgConfig] = useState<any[]>([]);
  const [pgConfigDirty, setPgConfigDirty] = useState<Record<string, string>>({});
  const [pgLoading, setPgLoading] = useState(false);
  const [pgSaving, setPgSaving] = useState(false);
  const [showAllConfig, setShowAllConfig] = useState(false);
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [dbStats, setDbStats] = useState<any>(null);

  // Cron
  const [cronJobs, setCronJobs] = useState<any[]>([]);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronForm, setCronForm] = useState({ schedule: "0 2 * * *", command: "" });
  const [cronAdding, setCronAdding] = useState(false);

  // Logs
  const [logType, setLogType] = useState("syslog");

  // SSH Keys
  const [sshKeys, setSshKeys] = useState<any[]>([]);
  const [sshKeysLoading, setSshKeysLoading] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState("");
  const [sshKeyAdding, setSshKeyAdding] = useState(false);

  // Settings
  const [settingsForm, setSettingsForm] = useState({ name: "", auto_os_updates: true, geoip: true });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [uptimeData, setUptimeData] = useState<any>(null);
  const [showDeleteServer, setShowDeleteServer] = useState(false);
  const [destroyCloud, setDestroyCloud] = useState(false);

  // Upgrade
  const [upgradePlans, setUpgradePlans] = useState<any>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeFilter, setUpgradeFilter] = useState<string>("upgrades");
  const [resizing, setResizing] = useState(false);

  // Nginx
  const [nginxSites, setNginxSites] = useState<any[]>([]);
  const [nginxLoading, setNginxLoading] = useState(false);
  const [nginxConfigModal, setNginxConfigModal] = useState<{ name: string; config: string } | null>(null);

  // Docker
  const [dockerContainers, setDockerContainers] = useState<any[]>([]);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [dockerLogModal, setDockerLogModal] = useState<{ name: string; lines: string[] } | null>(null);

  // Network
  const [networkData, setNetworkData] = useState<any>(null);
  const [networkLoading, setNetworkLoading] = useState(false);

  // SSH Hardening
  const [sshHardening, setSshHardening] = useState<any>(null);
  const [sshHardeningLoading, setSshHardeningLoading] = useState(false);
  const [sshHardeningDirty, setSshHardeningDirty] = useState<Record<string, any>>({});
  const [sshHardeningSaving, setSshHardeningSaving] = useState(false);

  // Swap
  const [swapData, setSwapData] = useState<any>(null);
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapCreateSize, setSwapCreateSize] = useState(1024);

  // Quick Actions
  const [quickActions, setQuickActions] = useState<any[]>([]);
  const [quickActionsLoading, setQuickActionsLoading] = useState(false);
  const [quickActionRunning, setQuickActionRunning] = useState<string | null>(null);
  const [quickActionResult, setQuickActionResult] = useState<{ action: string; output: string } | null>(null);

  // Forecast
  const [forecastData, setForecastData] = useState<any>(null);
  const [forecastLoading, setForecastLoading] = useState(false);

  // ─── Initial load ──────────────────────────────────────────────
  const loadServer = useCallback(async () => {
    try {
      const srv = await serversApi.get(serverId);
      setServer(srv);
      setSettingsForm({ name: srv.name, auto_os_updates: true, geoip: true });
    } catch {
      setToast({ message: "Failed to load server", type: "error" });
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const loadServices = useCallback(async () => {
    setServicesLoading(true);
    try { setServices(await serversApi.services(serverId)); }
    catch { setToast({ message: "Failed to load services", type: "error" }); }
    finally { setServicesLoading(false); }
  }, [serverId]);

  useEffect(() => { loadServer(); loadServices(); }, [loadServer, loadServices]);

  // Persist active tab
  useEffect(() => {
    const saved = localStorage.getItem(`server-tab-${serverId}`);
    if (saved && TABS.some(tb => tb.id === saved)) setActiveTab(saved as TabId);
  }, [serverId, TABS]);

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    localStorage.setItem(`server-tab-${serverId}`, tab);
  };

  // ─── Tab data loaders ──────────────────────────────────────────
  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      const data = await serversApi.detailedMetrics(serverId);
      // Ensure all required sections exist with defaults
      setDetailedMetrics({
        cpu: { load_avg_1: 0, load_avg_5: 0, load_avg_15: 0, cores: 0, per_core_percent: [], ...(data?.cpu || {}) },
        memory: { used_mb: 0, cached_mb: 0, free_mb: 0, total_mb: 1, swap_used_mb: 0, swap_total_mb: 0, ram_percent: 0, ...(data?.memory || {}) },
        disk: { partitions: [], io_read_mb: 0, io_write_mb: 0, ...(data?.disk || {}) },
        network: { interfaces: [], ...(data?.network || {}) },
        docker: { running: 0, total: 0, ...(data?.docker || {}) },
        system: { uptime_seconds: 0, processes: 0, ...(data?.system || {}) },
      });
    } catch {
      setToast({ message: "Failed to load metrics — server may be unreachable", type: "error" });
    } finally { setMetricsLoading(false); }
  }, [serverId]);

  const loadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try { setInstances(await instancesApi.list(serverId)); }
    catch { /* empty */ }
    finally { setInstancesLoading(false); }
  }, [serverId]);

  const loadSecurity = useCallback(async () => {
    setSecurityLoading(true);
    try {
      const [audit, fw] = await Promise.all([serversApi.security(serverId), serversApi.firewall(serverId)]);
      setSecurityAudit(audit);
      setFirewallData(fw);
    } catch { setToast({ message: "Failed to load security info", type: "error" }); }
    finally { setSecurityLoading(false); }
  }, [serverId]);

  const loadPostgres = useCallback(async () => {
    setPgLoading(true);
    try {
      const [dbs, cfg] = await Promise.allSettled([serversApi.databases(serverId), serversApi.postgresConfig(serverId)]);
      setDatabases(dbs.status === "fulfilled" ? (dbs.value || []) : []);
      setPgConfig(cfg.status === "fulfilled" ? (cfg.value || []) : []);
      setPgConfigDirty({});
      if (dbs.status === "rejected" && cfg.status === "rejected") {
        setToast({ message: "PostgreSQL not available on this server", type: "error" });
      }
    } catch { setToast({ message: "Failed to load PostgreSQL info", type: "error" }); }
    finally { setPgLoading(false); }
  }, [serverId]);

  const loadCron = useCallback(async () => {
    setCronLoading(true);
    try { setCronJobs(await serversApi.cronJobs(serverId)); }
    catch { setToast({ message: "Failed to load cron jobs", type: "error" }); }
    finally { setCronLoading(false); }
  }, [serverId]);

  const loadSshKeys = useCallback(async () => {
    setSshKeysLoading(true);
    try { setSshKeys(await serversApi.sshKeys(serverId)); }
    catch { setToast({ message: "Failed to load SSH keys", type: "error" }); }
    finally { setSshKeysLoading(false); }
  }, [serverId]);

  const loadUptime = useCallback(async () => {
    try { setUptimeData(await serversApi.uptime(serverId)); }
    catch { /* ignore */ }
  }, [serverId]);

  const loadUpgradePlans = useCallback(async () => {
    setUpgradeLoading(true);
    try { setUpgradePlans(await serversApi.upgradePlans(serverId)); }
    catch { setToast({ message: "Upgrade plans not available for this server", type: "error" }); }
    finally { setUpgradeLoading(false); }
  }, [serverId]);

  const loadNginx = useCallback(async () => {
    setNginxLoading(true);
    try { setNginxSites(await serversApi.nginxSites(serverId)); }
    catch { /* nginx may not be installed */ }
    finally { setNginxLoading(false); }
  }, [serverId]);

  const loadDocker = useCallback(async () => {
    setDockerLoading(true);
    try { setDockerContainers(await serversApi.dockerContainers(serverId)); }
    catch { setToast({ message: "Failed to load Docker containers", type: "error" }); }
    finally { setDockerLoading(false); }
  }, [serverId]);

  const loadNetwork = useCallback(async () => {
    setNetworkLoading(true);
    try { setNetworkData(await serversApi.networkOverview(serverId)); }
    catch { setToast({ message: "Failed to load network info", type: "error" }); }
    finally { setNetworkLoading(false); }
  }, [serverId]);

  const loadSshHardening = useCallback(async () => {
    setSshHardeningLoading(true);
    try {
      const data = await serversApi.sshHardening(serverId);
      setSshHardening(data);
      setSshHardeningDirty({});
    }
    catch { /* ssh may not be readable */ }
    finally { setSshHardeningLoading(false); }
  }, [serverId]);

  const loadSwap = useCallback(async () => {
    setSwapLoading(true);
    try { setSwapData(await serversApi.swapInfo(serverId)); }
    catch { /* ignore */ }
    finally { setSwapLoading(false); }
  }, [serverId]);

  const loadQuickActions = useCallback(async () => {
    setQuickActionsLoading(true);
    try { setQuickActions(await serversApi.quickActions(serverId)); }
    catch { /* ignore */ }
    finally { setQuickActionsLoading(false); }
  }, [serverId]);

  const loadForecast = useCallback(async () => {
    setForecastLoading(true);
    try { setForecastData(await serversApi.forecast(serverId)); }
    catch { /* ignore */ }
    finally { setForecastLoading(false); }
  }, [serverId]);

  // Load tab data on tab change
  useEffect(() => {
    if (!server) return;
    const loaders: Record<TabId, () => void> = {
      dashboard: () => {},
      monitoring: loadMetrics,
      instances: loadInstances,
      services: loadServices,
      security: loadSecurity,
      postgresql: loadPostgres,
      cron: loadCron,
      logs: () => {},
      sshkeys: loadSshKeys,
      settings: loadUptime,
      upgrade: loadUpgradePlans,
      nginx: loadNginx,
      docker: loadDocker,
      network: () => { loadNetwork(); loadForecast(); },
    };
    loaders[activeTab]?.();
  }, [activeTab, server, loadMetrics, loadInstances, loadServices, loadSecurity, loadPostgres, loadCron, loadSshKeys, loadUptime, loadUpgradePlans, loadNginx, loadDocker, loadNetwork, loadForecast]);

  // Auto-refresh for monitoring
  useEffect(() => {
    if (activeTab !== "monitoring" || !autoRefresh) return;
    const interval = setInterval(loadMetrics, 15000);
    return () => clearInterval(interval);
  }, [activeTab, autoRefresh, loadMetrics]);

  // ─── Actions ───────────────────────────────────────────────────
  const handleReboot = () => {
    setConfirmModal({
      title: t("rebootServer"),
      message: t("rebootConfirm"),
      danger: true,
      action: async () => {
        try {
          await serversApi.reboot(serverId);
          setToast({ message: t("rebootScheduled"), type: "success" });
        } catch { setToast({ message: "Reboot failed", type: "error" }); }
      },
    });
  };

  const handleRefreshSpecs = async () => {
    setActionLoading("specs");
    try {
      await serversApi.refreshSpecs(serverId);
      await loadServer();
      setToast({ message: "Specs refreshed", type: "success" });
    } catch { setToast({ message: "Failed to refresh specs", type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleServiceAction = async (serviceName: string, action: string) => {
    setActionLoading(`svc-${serviceName}-${action}`);
    try {
      await serversApi.serviceAction(serverId, serviceName, action);
      setToast({ message: t("serviceActionSuccess"), type: "success" });
      await loadServices();
    } catch { setToast({ message: t("serviceActionFailed"), type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleAddFirewallRule = async () => {
    if (!ruleForm.port) return;
    setActionLoading("add-rule");
    try {
      await serversApi.addFirewallRule(serverId, {
        port: parseInt(ruleForm.port),
        protocol: ruleForm.protocol,
        source: ruleForm.source || undefined,
        action: ruleForm.action,
        comment: ruleForm.comment || undefined,
      });
      setShowAddRuleModal(false);
      setRuleForm({ port: "", protocol: "tcp", source: "", action: "allow", comment: "" });
      setToast({ message: "Rule added", type: "success" });
      const fw = await serversApi.firewall(serverId);
      setFirewallData(fw);
    } catch { setToast({ message: "Failed to add rule", type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleDeleteFirewallRule = (ruleNumber: number) => {
    setConfirmModal({
      title: t("deleteRule"),
      message: t("confirmDeleteRule"),
      danger: true,
      action: async () => {
        try {
          await serversApi.deleteFirewallRule(serverId, ruleNumber);
          setToast({ message: "Rule deleted", type: "success" });
          const fw = await serversApi.firewall(serverId);
          setFirewallData(fw);
        } catch { setToast({ message: "Failed to delete rule", type: "error" }); }
      },
    });
  };

  const handleToggleFirewall = async (enabled: boolean) => {
    setActionLoading("toggle-fw");
    try {
      await serversApi.toggleFirewall(serverId, enabled);
      const fw = await serversApi.firewall(serverId);
      setFirewallData(fw);
      setToast({ message: enabled ? "Firewall enabled" : "Firewall disabled", type: "success" });
    } catch { setToast({ message: "Failed to toggle firewall", type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleSavePgConfig = async () => {
    if (Object.keys(pgConfigDirty).length === 0) return;
    setPgSaving(true);
    try {
      await serversApi.updatePostgresConfig(serverId, pgConfigDirty);
      setToast({ message: t("configSaved"), type: "success" });
      await loadPostgres();
    } catch { setToast({ message: t("configFailed"), type: "error" }); }
    finally { setPgSaving(false); }
  };

  const handleAddCron = async () => {
    if (!cronForm.command) return;
    setCronAdding(true);
    try {
      await serversApi.addCronJob(serverId, cronForm);
      setCronForm({ schedule: "0 2 * * *", command: "" });
      setToast({ message: "Cron job added", type: "success" });
      await loadCron();
    } catch { setToast({ message: "Failed to add cron job", type: "error" }); }
    finally { setCronAdding(false); }
  };

  const handleDeleteCron = (lineNumber: number) => {
    setConfirmModal({
      title: t("deleteCronJob"),
      message: t("confirmDeleteCron"),
      danger: true,
      action: async () => {
        try {
          await serversApi.deleteCronJob(serverId, lineNumber);
          setToast({ message: "Cron job deleted", type: "success" });
          await loadCron();
        } catch { setToast({ message: "Failed to delete cron job", type: "error" }); }
      },
    });
  };

  const handleAddSshKey = async () => {
    if (!newKeyInput.trim()) return;
    setSshKeyAdding(true);
    try {
      await serversApi.addSshKey(serverId, newKeyInput.trim());
      setNewKeyInput("");
      setToast({ message: t("sshKeyAdded"), type: "success" });
      await loadSshKeys();
    } catch { setToast({ message: "Failed to add SSH key", type: "error" }); }
    finally { setSshKeyAdding(false); }
  };

  const handleDeleteSshKey = (index: number) => {
    setConfirmModal({
      title: t("deleteSSHKey"),
      message: t("confirmDeleteKey"),
      danger: true,
      action: async () => {
        try {
          await serversApi.deleteSshKey(serverId, index);
          setToast({ message: t("sshKeyDeleted"), type: "success" });
          await loadSshKeys();
        } catch { setToast({ message: "Failed to delete SSH key", type: "error" }); }
      },
    });
  };

  const handleKillProcess = (pid: number) => {
    setConfirmModal({
      title: "Kill Process",
      message: `Terminate process ${pid}?`,
      danger: true,
      action: async () => {
        try {
          await serversApi.killProcess(serverId, pid);
          setToast({ message: `Process ${pid} terminated`, type: "success" });
          loadMetrics();
        } catch { setToast({ message: "Failed to kill process", type: "error" }); }
      },
    });
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      await serversApi.updateSettings(serverId, settingsForm);
      setToast({ message: t("settingsSaved"), type: "success" });
      await loadServer();
    } catch { setToast({ message: t("settingsFailed"), type: "error" }); }
    finally { setSettingsSaving(false); }
  };

  const handleDeleteServer = async () => {
    setActionLoading("delete-server");
    try {
      await serversApi.remove(serverId, destroyCloud);
      router.push("/");
    } catch { setToast({ message: "Failed to delete server", type: "error" }); setActionLoading(null); }
  };

  const handleResize = (planName: string) => {
    setConfirmModal({
      title: t("upgradeServer"),
      message: t("upgradeConfirm", { plan: planName }),
      danger: false,
      action: async () => {
        setResizing(true);
        try {
          await serversApi.resize(serverId, planName);
          setToast({ message: t("upgradeSuccess"), type: "success" });
          await loadUpgradePlans();
          await loadServer();
        } catch { setToast({ message: t("upgradeFailed"), type: "error" }); }
        finally { setResizing(false); }
      },
    });
  };

  const handleDbStats = async (dbName: string) => {
    if (selectedDb === dbName) { setSelectedDb(null); setDbStats(null); return; }
    setSelectedDb(dbName);
    try { setDbStats(await serversApi.databaseStats(serverId, dbName)); }
    catch { setDbStats(null); }
  };

  const handleDockerAction = async (containerId: string, action: string) => {
    setActionLoading(`docker-${containerId}-${action}`);
    try {
      await serversApi.dockerContainerAction(serverId, containerId, action);
      setToast({ message: t("containerActionSuccess"), type: "success" });
      await loadDocker();
    } catch { setToast({ message: t("containerActionFailed"), type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleDockerLogs = async (containerId: string, name: string) => {
    try {
      const data = await serversApi.dockerContainerLogs(serverId, containerId, 200);
      setDockerLogModal({ name, lines: data.lines || [] });
    } catch { setToast({ message: "Failed to load container logs", type: "error" }); }
  };

  const handleNginxToggle = async (siteName: string) => {
    setActionLoading(`nginx-${siteName}`);
    try {
      await serversApi.nginxToggleSite(serverId, siteName);
      setToast({ message: `Site ${siteName} toggled`, type: "success" });
      await loadNginx();
    } catch { setToast({ message: "Failed to toggle site", type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleNginxViewConfig = async (siteName: string) => {
    try {
      const data = await serversApi.nginxSiteConfig(serverId, siteName);
      setNginxConfigModal({ name: siteName, config: data.config });
    } catch { setToast({ message: "Failed to load config", type: "error" }); }
  };

  const handleNginxTest = async () => {
    setActionLoading("nginx-test");
    try {
      const data = await serversApi.nginxTest(serverId);
      setToast({ message: data.success ? t("nginxTestSuccess") : t("nginxTestFailed"), type: data.success ? "success" : "error" });
    } catch { setToast({ message: t("nginxTestFailed"), type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleSaveSshHardening = async () => {
    if (Object.keys(sshHardeningDirty).length === 0) return;
    setSshHardeningSaving(true);
    try {
      await serversApi.updateSshHardening(serverId, sshHardeningDirty);
      setToast({ message: t("sshHardeningSaved"), type: "success" });
      await loadSshHardening();
    } catch { setToast({ message: t("sshHardeningFailed"), type: "error" }); }
    finally { setSshHardeningSaving(false); }
  };

  const handleCreateSwap = async () => {
    setActionLoading("create-swap");
    try {
      await serversApi.createSwap(serverId, swapCreateSize);
      setToast({ message: t("swapCreated"), type: "success" });
      await loadSwap();
    } catch { setToast({ message: "Failed to create swap", type: "error" }); }
    finally { setActionLoading(null); }
  };

  const handleRemoveSwap = () => {
    setConfirmModal({
      title: t("removeSwap"),
      message: "Are you sure you want to remove the swap file?",
      danger: true,
      action: async () => {
        try {
          await serversApi.removeSwap(serverId);
          setToast({ message: t("swapRemoved"), type: "success" });
          await loadSwap();
        } catch { setToast({ message: "Failed to remove swap", type: "error" }); }
      },
    });
  };

  const handleQuickAction = async (actionId: string) => {
    setQuickActionRunning(actionId);
    try {
      const result = await serversApi.executeQuickAction(serverId, actionId);
      setQuickActionResult({ action: actionId, output: result.output || "" });
      setToast({ message: t("quickActionExecuted"), type: "success" });
    } catch { setToast({ message: t("quickActionFailed"), type: "error" }); }
    finally { setQuickActionRunning(null); }
  };

  // ─── Confirm modal handler ────────────────────────────────────
  const executeConfirm = async () => {
    if (!confirmModal) return;
    setConfirmLoading(true);
    await confirmModal.action();
    setConfirmLoading(false);
    setConfirmModal(null);
  };

  // ─── Helpers ───────────────────────────────────────────────────
  const specs = server?.specs;
  const formatBytes = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
  const formatUptime = (seconds: number) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d ${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const cronPresets = [
    { label: t("cronEveryMinute"), value: "* * * * *" },
    { label: t("cronEvery5Min"), value: "*/5 * * * *" },
    { label: t("cronEvery15Min"), value: "*/15 * * * *" },
    { label: t("cronHourly"), value: "0 * * * *" },
    { label: t("cronDaily"), value: "0 2 * * *" },
    { label: t("cronWeekly"), value: "0 2 * * 0" },
    { label: t("cronMonthly"), value: "0 2 1 * *" },
  ];

  const logTypes = [
    { value: "syslog", label: t("logSyslog") },
    { value: "auth", label: t("logAuth") },
    { value: "nginx_access", label: t("logNginxAccess") },
    { value: "nginx_error", label: t("logNginxError") },
    { value: "fail2ban", label: t("logFail2ban") },
    { value: "docker", label: t("logDocker") },
    { value: "postgresql", label: t("logPostgresql") },
    { value: "kern", label: t("logKernel") },
  ];

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <AuthGuard>
        <div className="flex h-screen bg-[var(--background)]">
          <Sidebar />
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={32} className="animate-spin text-[var(--accent)]" />
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (!server) {
    return (
      <AuthGuard>
        <div className="flex h-screen bg-[var(--background)]">
          <Sidebar />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <XCircle size={48} className="text-[var(--danger)] mx-auto mb-3" />
              <p className="text-[var(--muted)]">Server not found</p>
              <button onClick={() => router.push("/")} className="mt-4 text-[var(--accent)] text-sm hover:underline">{t("back")}</button>
            </div>
          </div>
        </div>
      </AuthGuard>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // TAB CONTENT RENDERERS
  // ═══════════════════════════════════════════════════════════════

  const renderDashboard = () => (
    <div className="space-y-6">
      {/* Quick metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard icon={Cpu} label={t("cpuCores")} value={specs?.cpu_cores || "N/A"} sublabel={specs?.cpu_model || ""} />
        <MetricCard icon={MemoryStick} label={t("totalRAM")} value={specs ? formatBytes(specs.ram_mb) : "N/A"} />
        <MetricCard icon={HardDrive} label={t("totalDisk")} value={specs ? `${specs.disk_gb} GB` : "N/A"} sublabel={specs ? `${specs.disk_used_gb} GB ${t("used").toLowerCase()}` : ""} />
        <MetricCard icon={Box} label={t("instancesRunning")} value={server.instances_count || 0} />
      </div>

      {/* Server info */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
        <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">{t("serverInfo")}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("ipAddress")}</span>
            <span className="text-[var(--foreground)] font-mono">{server.endpoint}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("provider")}</span>
            <span className="text-[var(--foreground)] capitalize">{server.provider}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("region")}</span>
            <span className="text-[var(--foreground)]">{server.region || "N/A"}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("operatingSystem")}</span>
            <span className="text-[var(--foreground)]">{specs?.os || "N/A"}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("kernel")}</span>
            <span className="text-[var(--foreground)] font-mono text-xs">{specs?.kernel || "N/A"}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("architecture")}</span>
            <span className="text-[var(--foreground)]">{specs?.arch || "N/A"}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-[var(--border)]">
            <span className="text-[var(--muted)]">{t("provider") + " Plan"}</span>
            <span className="text-[var(--foreground)]">{server.provider_plan || "N/A"}</span>
          </div>
        </div>
      </div>

      {/* Resource bars */}
      {server.status === "online" && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <ResourceBarsInline serverId={serverId} />
        </div>
      )}
    </div>
  );

  const renderMonitoring = () => {
    if (metricsLoading && !detailedMetrics) {
      return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    }
    if (!detailedMetrics) return <div className="text-center text-[var(--muted)] py-20">No metrics available</div>;
    const m = detailedMetrics;
    return (
      <div className="space-y-6">
        {/* Controls */}
        <div className="flex items-center gap-3 justify-end">
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} />
            {t("autoRefresh")}
          </label>
          <button onClick={loadMetrics} disabled={metricsLoading} className="px-3 py-1.5 text-xs bg-[var(--card)] border border-[var(--border)] rounded-lg flex items-center gap-1.5 hover:bg-[var(--card-hover)]">
            <RefreshCw size={12} className={metricsLoading ? "animate-spin" : ""} /> {t("refreshNow")}
          </button>
        </div>

        {/* CPU */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("cpuUsage")}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("load1m")}</div>
              <div className="text-lg font-bold">{m.cpu.load_avg_1}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("load5m")}</div>
              <div className="text-lg font-bold">{m.cpu.load_avg_5}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("load15m")}</div>
              <div className="text-lg font-bold">{m.cpu.load_avg_15}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("cpuCores")}</div>
              <div className="text-lg font-bold">{m.cpu.cores}</div>
            </div>
          </div>
          <div className="space-y-2">
            {m.cpu.per_core_percent.map((pct: number, i: number) => (
              <ProgressBar key={i} value={pct} label={`${t("core")} ${i}`} sublabel={`${pct.toFixed(1)}%`} color="#f59e0b" />
            ))}
          </div>
        </div>

        {/* Memory */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("memoryUsage")}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("used")}</div>
              <div className="text-lg font-bold">{formatBytes(m.memory.used_mb)}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("cached")}</div>
              <div className="text-lg font-bold">{formatBytes(m.memory.cached_mb)}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("free")}</div>
              <div className="text-lg font-bold">{formatBytes(m.memory.free_mb)}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("swapUsage")}</div>
              <div className="text-lg font-bold">{formatBytes(m.memory.swap_used_mb)}/{formatBytes(m.memory.swap_total_mb)}</div>
            </div>
          </div>
          {/* Stacked memory bar */}
          <div className="w-full h-4 bg-[var(--border)] rounded-full overflow-hidden flex">
            <div className="h-full bg-orange-500" style={{ width: `${(m.memory.used_mb / m.memory.total_mb * 100)}%` }} title={t("used")} />
            <div className="h-full bg-yellow-500" style={{ width: `${(m.memory.cached_mb / m.memory.total_mb * 100)}%` }} title={t("cached")} />
            <div className="h-full bg-green-500" style={{ width: `${(m.memory.free_mb / m.memory.total_mb * 100)}%` }} title={t("free")} />
          </div>
          <div className="flex gap-4 mt-2 text-xs text-[var(--muted)]">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-500" />{t("used")}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-500" />{t("cached")}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500" />{t("free")}</span>
          </div>
          <ProgressBar value={m.memory.ram_percent} label="RAM" sublabel={`${m.memory.ram_percent.toFixed(1)}%`} color="#f59e0b" />
        </div>

        {/* Disk */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("diskPartitions")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="text-left py-2 font-medium">{t("filesystem")}</th>
                  <th className="text-left py-2 font-medium">{t("mountPoint")}</th>
                  <th className="text-left py-2 font-medium">{t("size")}</th>
                  <th className="text-left py-2 font-medium">{t("used")}</th>
                  <th className="text-left py-2 font-medium">{t("available")}</th>
                  <th className="text-left py-2 font-medium w-40">Usage</th>
                </tr>
              </thead>
              <tbody>
                {m.disk.partitions.map((p: any, i: number) => (
                  <tr key={i} className="border-b border-[var(--border)]/50">
                    <td className="py-2 font-mono text-xs">{p.filesystem}</td>
                    <td className="py-2 font-mono text-xs">{p.mount}</td>
                    <td className="py-2">{p.size_gb} GB</td>
                    <td className="py-2">{p.used_gb} GB</td>
                    <td className="py-2">{p.available_gb} GB</td>
                    <td className="py-2"><ProgressBar value={p.percent} color="#f59e0b" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <div className="p-3 bg-[var(--background)] rounded-lg text-center">
              <div className="text-xs text-[var(--muted)]">{t("diskIO")} {t("readMB")}</div>
              <div className="text-lg font-bold">{m.disk.io_read_mb.toFixed(1)} MB</div>
            </div>
            <div className="p-3 bg-[var(--background)] rounded-lg text-center">
              <div className="text-xs text-[var(--muted)]">{t("diskIO")} {t("writeMB")}</div>
              <div className="text-lg font-bold">{m.disk.io_write_mb.toFixed(1)} MB</div>
            </div>
          </div>
        </div>

        {/* Network */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("networkInterfaces")}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                <th className="text-left py-2 font-medium">{t("interface")}</th>
                <th className="text-left py-2 font-medium">{t("received")}</th>
                <th className="text-left py-2 font-medium">{t("transmitted")}</th>
              </tr>
            </thead>
            <tbody>
              {m.network.interfaces.map((iface: any, i: number) => (
                <tr key={i} className="border-b border-[var(--border)]/50">
                  <td className="py-2 font-mono text-xs">{iface.name}</td>
                  <td className="py-2">{iface.rx_mb.toFixed(2)} MB</td>
                  <td className="py-2">{iface.tx_mb.toFixed(2)} MB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Docker & System */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-3">{t("dockerStats")}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                <div className="text-xs text-[var(--muted)]">{t("runningContainers")}</div>
                <div className="text-2xl font-bold text-emerald-500">{m.docker.running}</div>
              </div>
              <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                <div className="text-xs text-[var(--muted)]">{t("totalContainers")}</div>
                <div className="text-2xl font-bold">{m.docker.total}</div>
              </div>
            </div>
          </div>
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
            <h3 className="text-sm font-semibold mb-3">System</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                <div className="text-xs text-[var(--muted)]">{t("uptimeLabel")}</div>
                <div className="text-lg font-bold">{formatUptime(m.system.uptime_seconds)}</div>
              </div>
              <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                <div className="text-xs text-[var(--muted)]">{t("processes")}</div>
                <div className="text-lg font-bold">{m.system.processes}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Historical Charts + Alerting */}
        <MonitoringCharts serverId={serverId} active={activeTab === "monitoring"} />
      </div>
    );
  };

  const renderInstances = () => {
    if (instancesLoading) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    if (!instances.length) {
      return (
        <div className="text-center py-20">
          <Box size={48} className="text-[var(--muted)] mx-auto mb-3" />
          <p className="text-[var(--muted)]">{t("noInstances")}</p>
          <button onClick={() => router.push("/instances")} className="mt-3 px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm">{t("createInstance")}</button>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {instances.map((inst: any) => (
          <div key={inst.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 flex items-center justify-between hover:border-[var(--accent)]/30 transition-colors cursor-pointer" onClick={() => router.push(`/instances/${inst.id}`)}>
            <div className="flex items-center gap-4">
              <div className={`w-2.5 h-2.5 rounded-full ${inst.status === "running" ? "bg-emerald-500" : inst.status === "stopped" ? "bg-gray-500" : "bg-yellow-500"}`} />
              <div>
                <div className="font-medium text-sm">{inst.name}</div>
                <div className="text-xs text-[var(--muted)]">{inst.domain || "No domain"}</div>
              </div>
            </div>
            <div className="flex items-center gap-6 text-xs text-[var(--muted)]">
              <span className="uppercase font-mono">{inst.cms_type}</span>
              <span>{inst.version}</span>
              <span>{inst.workers} {t("workers")}</span>
              <span>{inst.ram_mb} MB</span>
              <ExternalLink size={14} className="text-[var(--accent)]" />
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderServices = () => {
    if (servicesLoading && !services.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    const installed = services.filter((s: any) => s.installed !== false);
    const notInstalled = services.filter((s: any) => s.installed === false);
    return (
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{t("serviceManagement")}</h3>
          <button onClick={loadServices} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
            <RefreshCw size={12} /> {t("refreshNow")}
          </button>
        </div>
        {installed.length === 0 ? (
          <p className="text-[var(--muted)] text-sm text-center py-8">{t("noServices")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                <th className="text-left py-2 font-medium">{t("serviceName")}</th>
                <th className="text-left py-2 font-medium">{t("serviceStatus")}</th>
                <th className="text-left py-2 font-medium">{t("serviceVersion")}</th>
                <th className="text-left py-2 font-medium">{t("serviceEnabled")}</th>
                <th className="text-right py-2 font-medium">{t("serviceActions")}</th>
              </tr>
            </thead>
            <tbody>
              {installed.map((svc: any) => (
                <tr key={svc.name} className="border-b border-[var(--border)]/50">
                  <td className="py-3 font-mono text-xs">{svc.name}</td>
                  <td className="py-3">
                    <span className={`flex items-center gap-1.5 ${svc.active === "active" ? "text-emerald-500" : "text-red-500"}`}>
                      <span className={`w-2 h-2 rounded-full ${svc.active === "active" ? "bg-emerald-500" : "bg-red-500"}`} />
                      {svc.active === "active" ? t("serviceRunning") : t("serviceStopped")}
                    </span>
                  </td>
                  <td className="py-3 text-xs text-[var(--muted)]">{svc.version || "—"}</td>
                  <td className="py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${svc.enabled === "enabled" ? "bg-emerald-500/10 text-emerald-500" : "bg-gray-500/10 text-gray-500"}`}>
                      {svc.enabled === "enabled" ? "Yes" : "No"}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex gap-1 justify-end">
                      {svc.active === "active" ? (
                        <>
                          <button disabled={actionLoading === `svc-${svc.name}-restart`} onClick={() => handleServiceAction(svc.name, "restart")} className="px-2 py-1 text-xs bg-orange-500/10 text-orange-500 rounded hover:bg-orange-500/20">
                            {actionLoading === `svc-${svc.name}-restart` ? <Loader2 size={12} className="animate-spin" /> : t("serviceRestart")}
                          </button>
                          <button disabled={actionLoading === `svc-${svc.name}-stop`} onClick={() => handleServiceAction(svc.name, "stop")} className="px-2 py-1 text-xs bg-red-500/10 text-red-500 rounded hover:bg-red-500/20">
                            {t("serviceStop")}
                          </button>
                        </>
                      ) : (
                        <button disabled={actionLoading === `svc-${svc.name}-start`} onClick={() => handleServiceAction(svc.name, "start")} className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-500 rounded hover:bg-emerald-500/20">
                          {t("serviceStart")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {notInstalled.length > 0 && (
          <p className="text-xs text-[var(--muted)] mt-3">
            {notInstalled.map((s: any) => s.name).join(", ")} — not installed (managed via Docker)
          </p>
        )}
      </div>
    );
  };

  const renderSecurity = () => {
    if (securityLoading && !securityAudit) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    const score = securityAudit?.security_score || 0;
    const scoreColor = score >= 80 ? "text-emerald-500" : score >= 60 ? "text-yellow-500" : "text-red-500";
    const scoreLabel = score >= 80 ? t("securityExcellent") : score >= 60 ? t("securityGood") : score >= 40 ? t("securityFair") : t("securityPoor");
    return (
      <div className="space-y-6">
        {/* Score + overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 text-center">
            <div className={`text-5xl font-bold ${scoreColor}`}>{score}</div>
            <div className="text-xs text-[var(--muted)] mt-1">{t("securityScore")}</div>
            <div className={`text-sm font-medium mt-1 ${scoreColor}`}>{scoreLabel}</div>
          </div>
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 space-y-3">
            <SecurityItem label={t("firewallStatus")} ok={securityAudit?.firewall?.enabled} detail={securityAudit?.firewall?.detail} />
            <SecurityItem label={t("fail2banStatus")} ok={securityAudit?.fail2ban?.active} detail={`${securityAudit?.fail2ban?.banned_ips || 0} ${t("bannedIPs")}`} />
            <SecurityItem label={t("sshHardening")} ok={securityAudit?.ssh?.password_auth_disabled} detail={securityAudit?.ssh?.password_auth_disabled ? t("passwordAuthDisabled") : t("passwordAuthEnabled")} />
          </div>
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 space-y-3">
            <SecurityItem label={t("autoUpdates")} ok={securityAudit?.auto_updates?.active} />
            <SecurityItem label="Docker" ok={securityAudit?.docker?.installed} detail={securityAudit?.docker?.version} />
            <SecurityItem label={t("rebootRequired")} ok={!securityAudit?.reboot_required} detail={securityAudit?.reboot_required ? t("rebootRequired") : t("noRebootRequired")} />
          </div>
        </div>

        {/* Firewall rules */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold">{t("firewallRules")}</h3>
              {firewallData && (
                <Toggle checked={firewallData.enabled} onChange={(v) => handleToggleFirewall(v)} disabled={actionLoading === "toggle-fw"} />
              )}
            </div>
            <button onClick={() => setShowAddRuleModal(true)} className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5">
              <Plus size={12} /> {t("addRule")}
            </button>
          </div>
          {firewallData?.rules?.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="text-left py-2 font-medium">#</th>
                  <th className="text-left py-2 font-medium">{t("port")}</th>
                  <th className="text-left py-2 font-medium">{t("action")}</th>
                  <th className="text-left py-2 font-medium">{t("source")}</th>
                  <th className="text-left py-2 font-medium">{t("comment")}</th>
                  <th className="text-right py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {firewallData.rules.map((rule: any) => (
                  <tr key={rule.number} className="border-b border-[var(--border)]/50">
                    <td className="py-2 text-[var(--muted)]">{rule.number}</td>
                    <td className="py-2 font-mono text-xs">{rule.to}</td>
                    <td className="py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${rule.action === "ALLOW" ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
                        {rule.action}
                      </span>
                    </td>
                    <td className="py-2 text-xs">{rule.from_addr || t("anywhere")}</td>
                    <td className="py-2 text-xs text-[var(--muted)]">{rule.comment || "—"}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => handleDeleteFirewallRule(rule.number)} className="text-red-500 hover:text-red-400">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[var(--muted)] text-sm text-center py-4">No firewall rules</p>
          )}
        </div>

        {/* Add Rule Modal */}
        {showAddRuleModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-md w-full">
              <h3 className="text-lg font-semibold mb-4">{t("addRule")}</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[var(--muted)]">{t("port")}</label>
                  <input value={ruleForm.port} onChange={e => setRuleForm(p => ({...p, port: e.target.value}))} type="number" className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm" placeholder="80" />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">{t("protocol")}</label>
                  <select value={ruleForm.protocol} onChange={e => setRuleForm(p => ({...p, protocol: e.target.value}))} className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm">
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="any">Any</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">{t("action")}</label>
                  <select value={ruleForm.action} onChange={e => setRuleForm(p => ({...p, action: e.target.value}))} className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm">
                    <option value="allow">{t("allow")}</option>
                    <option value="deny">{t("deny")}</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">{t("source")} (IP, optional)</label>
                  <input value={ruleForm.source} onChange={e => setRuleForm(p => ({...p, source: e.target.value}))} className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm" placeholder={t("anywhere")} />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)]">{t("comment")}</label>
                  <input value={ruleForm.comment} onChange={e => setRuleForm(p => ({...p, comment: e.target.value}))} className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm" placeholder="Optional" />
                </div>
              </div>
              <div className="flex gap-3 justify-end mt-6">
                <button onClick={() => setShowAddRuleModal(false)} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] text-[var(--muted)]">Cancel</button>
                <button onClick={handleAddFirewallRule} disabled={actionLoading === "add-rule" || !ruleForm.port} className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded-lg flex items-center gap-2">
                  {actionLoading === "add-rule" && <Loader2 size={14} className="animate-spin" />}
                  {t("addRule")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Fail2ban Management */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <Fail2banManager serverId={serverId} active={activeTab === "security"} />
        </div>

        {/* SSL / Let's Encrypt Management */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <SslManager serverId={serverId} active={activeTab === "security"} />
        </div>

        {/* Vulnerability Scanner */}
        <SecurityScanner serverId={serverId} />
      </div>
    );
  };

  const renderPostgreSQL = () => {
    if (pgLoading && !databases.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    return (
      <div className="space-y-6">
        {/* Databases */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("databaseList")}</h3>
          {databases.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-4">{t("noDatabases")}</p>
          ) : (
            <div className="space-y-2">
              {databases.map((db: any) => (
                <div key={db.name} className="border border-[var(--border)] rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between p-3 cursor-pointer hover:bg-[var(--card-hover)]" onClick={() => handleDbStats(db.name)}>
                    <div className="flex items-center gap-3">
                      <Database size={16} className="text-[var(--accent)]" />
                      <span className="font-mono text-sm">{db.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-[var(--muted)]">{db.size_human}</span>
                      {selectedDb === db.name ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>
                  {selectedDb === db.name && dbStats && (
                    <div className="border-t border-[var(--border)] p-4 bg-[var(--background)] grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="text-center">
                        <div className="text-xs text-[var(--muted)]">{t("tableCount")}</div>
                        <div className="text-lg font-bold">{dbStats.table_count}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-[var(--muted)]">{t("activeConnections")}</div>
                        <div className="text-lg font-bold">{dbStats.active_connections}</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-[var(--muted)]">{t("cacheHitRatio")}</div>
                        <div className="text-lg font-bold text-emerald-500">{dbStats.cache_hit_ratio}%</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-[var(--muted)]">{t("databaseSize")}</div>
                        <div className="text-lg font-bold">{dbStats.size_human}</div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* PostgreSQL Config */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("postgresConfig")}</h3>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <Toggle checked={showAllConfig} onChange={setShowAllConfig} />
                {t("showAdditionalConfig")}
              </label>
              <button onClick={handleSavePgConfig} disabled={pgSaving || Object.keys(pgConfigDirty).length === 0} className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {pgSaving ? <Loader2 size={12} className="animate-spin" /> : null}
                {t("saveConfig")}
              </button>
            </div>
          </div>
          <div className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2 mb-4">
            Changes affect only this server&apos;s PostgreSQL service and not external PostgreSQL databases.
          </div>
          {pgConfig.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-8">{t("noDatabases")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="text-left py-2 font-medium">{t("configName")}</th>
                  <th className="text-left py-2 font-medium">{t("configValue")}</th>
                </tr>
              </thead>
              <tbody>
                {pgConfig.filter((_, i) => showAllConfig || i < 16).map((param: any) => (
                  <tr key={param.name} className="border-b border-[var(--border)]/50">
                    <td className="py-2">
                      <div className="font-medium text-xs">{param.name}</div>
                      {param.description && <div className="text-[10px] text-[var(--muted)] mt-0.5">{param.description}</div>}
                    </td>
                    <td className="py-2">
                      <input
                        value={pgConfigDirty[param.name] !== undefined ? pgConfigDirty[param.name] : param.setting}
                        onChange={e => setPgConfigDirty(prev => ({...prev, [param.name]: e.target.value}))}
                        className="w-full px-2 py-1 bg-[var(--background)] border border-[var(--border)] rounded text-xs font-mono"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  const renderCron = () => {
    if (cronLoading && !cronJobs.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    return (
      <div className="space-y-6">
        {/* Add cron job */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("addCronJob")}</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="text-xs text-[var(--muted)]">{t("cronPresets")}:</span>
            {cronPresets.map(p => (
              <button key={p.value} onClick={() => setCronForm(f => ({...f, schedule: p.value}))} className={`px-2 py-1 text-xs rounded border ${cronForm.schedule === p.value ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <input value={cronForm.schedule} onChange={e => setCronForm(f => ({...f, schedule: e.target.value}))} className="w-40 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm font-mono" placeholder="* * * * *" />
            <input value={cronForm.command} onChange={e => setCronForm(f => ({...f, command: e.target.value}))} className="flex-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm font-mono" placeholder="/usr/bin/command --arg" />
            <button onClick={handleAddCron} disabled={cronAdding || !cronForm.command} className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
              {cronAdding && <Loader2 size={14} className="animate-spin" />}
              <Plus size={14} /> {t("addCronJob")}
            </button>
          </div>
        </div>

        {/* Cron list */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("cronJobManagement")}</h3>
          {cronJobs.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-8">{t("noCronJobs")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="text-left py-2 font-medium">{t("cronSchedule")}</th>
                  <th className="text-left py-2 font-medium">{t("cronCommand")}</th>
                  <th className="text-left py-2 font-medium">{t("cronSource")}</th>
                  <th className="text-right py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {cronJobs.map((job: any, i: number) => (
                  <tr key={i} className="border-b border-[var(--border)]/50">
                    <td className="py-2 font-mono text-xs">{job.schedule}</td>
                    <td className="py-2 font-mono text-xs max-w-md truncate">{job.command}</td>
                    <td className="py-2 text-xs text-[var(--muted)]">{job.source || "user"}</td>
                    <td className="py-2 text-right">
                      {job.source === "user" && (
                        <button onClick={() => handleDeleteCron(job.line_number)} className="text-red-500 hover:text-red-400">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  const renderLogs = () => (
    <LogViewer
      logUrl={`/api/v1/servers/${serverId}/logs?type=${logType}`}
      active={activeTab === "logs"}
      title={t("serverLogs")}
      extraToolbar={
        <select
          value={logType}
          onChange={e => setLogType(e.target.value)}
          className="text-xs bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1 text-gray-300 focus:border-blue-500 focus:outline-none"
        >
          {logTypes.map(lt => <option key={lt.value} value={lt.value}>{lt.label}</option>)}
        </select>
      }
    />
  );

  const renderSshKeys = () => {
    if (sshKeysLoading && !sshKeys.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    return (
      <div className="space-y-6">
        {/* Add key */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-3">{t("addSSHKey")}</h3>
          <textarea
            value={newKeyInput}
            onChange={e => setNewKeyInput(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-xs font-mono h-24 resize-none"
            placeholder={t("sshKeyPlaceholder")}
          />
          <div className="flex justify-end mt-3">
            <button onClick={handleAddSshKey} disabled={sshKeyAdding || !newKeyInput.trim()} className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
              {sshKeyAdding && <Loader2 size={14} className="animate-spin" />}
              <Plus size={14} /> {t("addSSHKey")}
            </button>
          </div>
        </div>

        {/* Key list */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("sshKeyManagement")}</h3>
            <span className="text-xs text-[var(--muted)]">{sshKeys.length} keys</span>
          </div>
          <div className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2 mb-4">
            Warning: Changes to your server using the SSH Terminal are made at your own risk. Misconfigurations may result in issues or downtime.
          </div>
          {sshKeys.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-8">{t("noSSHKeys")}</p>
          ) : (
            <div className="space-y-2">
              {sshKeys.map((key: any) => (
                <div key={key.index} className="flex items-center justify-between p-3 border border-[var(--border)] rounded-lg">
                  <div className="flex items-center gap-3 min-w-0">
                    <Key size={16} className="text-[var(--muted)] shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{key.comment || "Unnamed key"}</div>
                      <div className="text-xs text-[var(--muted)] font-mono">{key.type} ...{key.fingerprint}</div>
                    </div>
                  </div>
                  <button onClick={() => handleDeleteSshKey(key.index)} className="text-red-500 hover:text-red-400 shrink-0 ml-3">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    <div className="space-y-6">
      {/* Server settings */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
        <h3 className="text-sm font-semibold mb-4">{t("serverSettings")}</h3>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-[var(--muted)]">{t("serverName")}</label>
            <input value={settingsForm.name} onChange={e => setSettingsForm(f => ({...f, name: e.target.value}))} className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm" />
          </div>
          <div>
            <label className="text-xs text-[var(--muted)]">{t("serverRegion")}</label>
            <div className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm text-[var(--muted)]">{server?.region || "N/A"}</div>
          </div>
        </div>
      </div>

      {/* Toggles */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
        <h3 className="text-sm font-semibold mb-4">Server-wide settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{t("autoOSUpdates")}</div>
              <div className="text-xs text-[var(--muted)] mt-0.5">{t("autoOSUpdatesDesc")}</div>
            </div>
            <Toggle checked={settingsForm.auto_os_updates} onChange={v => setSettingsForm(f => ({...f, auto_os_updates: v}))} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{t("geoIPDatabase")}</div>
              <div className="text-xs text-[var(--muted)] mt-0.5">{t("geoIPDatabaseDesc")}</div>
            </div>
            <Toggle checked={settingsForm.geoip} onChange={v => setSettingsForm(f => ({...f, geoip: v}))} />
          </div>
        </div>
        <div className="flex justify-end mt-6">
          <button onClick={handleSaveSettings} disabled={settingsSaving} className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm flex items-center gap-2">
            {settingsSaving && <Loader2 size={14} className="animate-spin" />}
            {t("save")}
          </button>
        </div>
      </div>

      {/* Uptime */}
      {uptimeData && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4">{t("uptimeInfo")}</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted)]">{t("uptimeLabel")}</span>
              <span>{uptimeData.uptime_text}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted)]">{t("lastBoot")}</span>
              <span>{uptimeData.last_boot}</span>
            </div>
            {uptimeData.reboot_history?.length > 0 && (
              <div>
                <div className="text-[var(--muted)] mb-2">{t("rebootHistory")}</div>
                {uptimeData.reboot_history.map((r: any, i: number) => (
                  <div key={i} className="text-xs font-mono text-[var(--muted)] py-1">
                    {typeof r === "string" ? r : `${r.timestamp || ""} — ${r.details || ""}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Danger zone */}
      <div className="bg-[var(--card)] border border-red-500/30 rounded-xl p-6">
        <h3 className="text-sm font-semibold text-red-500 mb-3">{t("deleteServer")}</h3>
        <p className="text-xs text-[var(--muted)] mb-4">{t("deleteServerConfirm")}</p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <input type="checkbox" checked={destroyCloud} onChange={e => setDestroyCloud(e.target.checked)} className="rounded" />
            {t("deleteServerDestroyCloud")}
          </label>
        </div>
        <button onClick={() => setShowDeleteServer(true)} className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700">
          <Trash2 size={14} className="inline mr-2" />
          {t("deleteServer")}
        </button>
      </div>

      {showDeleteServer && (
        <ConfirmModal
          title={t("deleteServer")}
          message={t("deleteServerConfirm")}
          danger
          loading={actionLoading === "delete-server"}
          onConfirm={handleDeleteServer}
          onCancel={() => setShowDeleteServer(false)}
        />
      )}
    </div>
  );

  const renderUpgrade = () => {
    if (upgradeLoading && !upgradePlans) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    if (!upgradePlans) return <div className="text-center text-[var(--muted)] py-20">{t("upgradeNotAvailable")}</div>;

    const filteredPlans = (upgradePlans.plans || []).filter((p: any) => {
      if (upgradeFilter === "upgrades") return p.is_upgrade;
      if (upgradeFilter === "all") return true;
      if (upgradeFilter === "dedicated") return p.cpu_type === "dedicated";
      if (upgradeFilter === "shared") return p.cpu_type === "shared";
      return true;
    });

    return (
      <div className="space-y-6">
        {/* Current Plan */}
        <div className="bg-[var(--card)] border border-[var(--accent)]/30 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-3">
            <ArrowUpCircle size={20} className="text-[var(--accent)]" />
            <h3 className="text-sm font-semibold">{t("currentPlan")}</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("plan")}</div>
              <div className="text-lg font-bold font-mono">{upgradePlans.current_plan || "N/A"}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("cpuCores")}</div>
              <div className="text-lg font-bold">{specs?.cpu_cores || "N/A"}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("totalRAM")}</div>
              <div className="text-lg font-bold">{specs ? formatBytes(specs.ram_mb) : "N/A"}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("totalDisk")}</div>
              <div className="text-lg font-bold">{specs ? `${specs.disk_gb} GB` : "N/A"}</div>
            </div>
            <div className="text-center p-3 bg-[var(--background)] rounded-lg">
              <div className="text-xs text-[var(--muted)] mb-1">{t("provider")}</div>
              <div className="text-lg font-bold capitalize">{upgradePlans.provider}</div>
            </div>
          </div>
        </div>

        {/* Warning */}
        <div className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-3">
          <AlertTriangle size={14} className="inline mr-2" />
          {t("upgradeWarning")}
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2">
          {[
            { value: "upgrades", label: t("upgradesOnly") },
            { value: "all", label: t("allPlans") },
            { value: "dedicated", label: t("dedicatedCPU") },
            { value: "shared", label: t("sharedCPU") },
          ].map(f => (
            <button key={f.value} onClick={() => setUpgradeFilter(f.value)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${upgradeFilter === f.value ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
              {f.label}
            </button>
          ))}
          <span className="text-xs text-[var(--muted)] ml-2">{filteredPlans.length} plans</span>
        </div>

        {/* Plans grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPlans.map((plan: any) => (
            <div key={plan.name} className={`bg-[var(--card)] border rounded-xl p-5 transition-colors ${plan.is_current ? "border-[var(--accent)] ring-1 ring-[var(--accent)]/30" : "border-[var(--border)] hover:border-[var(--accent)]/30"}`}>
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono font-bold text-sm">{plan.name}</span>
                {plan.is_current && <span className="text-[10px] px-2 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] rounded-full font-medium">{t("current")}</span>}
              </div>
              <div className="space-y-2 text-sm mb-4">
                <div className="flex justify-between"><span className="text-[var(--muted)]">{t("cpuCores")}</span><span className="font-medium">{plan.cores} {plan.cpu_type === "dedicated" ? "(Dedicated)" : "(Shared)"}</span></div>
                <div className="flex justify-between"><span className="text-[var(--muted)]">{t("totalRAM")}</span><span className="font-medium">{plan.memory_gb} GB</span></div>
                <div className="flex justify-between"><span className="text-[var(--muted)]">{t("totalDisk")}</span><span className="font-medium">{plan.disk_gb} GB {plan.disk_type}</span></div>
                <div className="flex justify-between"><span className="text-[var(--muted)]">{t("category")}</span><span className="text-xs font-medium">{plan.plan_category}</span></div>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
                <div>
                  <span className="text-lg font-bold">{plan.price_monthly > 0 ? `€${plan.price_monthly.toFixed(2)}` : "N/A"}</span>
                  <span className="text-xs text-[var(--muted)] ml-1">/mo</span>
                </div>
                {!plan.is_current && (
                  <button onClick={() => handleResize(plan.name)} disabled={resizing}
                    className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5">
                    {resizing ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpCircle size={12} />}
                    {plan.is_upgrade ? t("upgrade") : t("changeplan")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderNginx = () => {
    if (nginxLoading && !nginxSites.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    return (
      <div className="space-y-6">
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("nginxSites")}</h3>
            <button onClick={handleNginxTest} disabled={actionLoading === "nginx-test"} className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5">
              {actionLoading === "nginx-test" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
              {t("nginxTestConfig")}
            </button>
          </div>
          {nginxSites.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-8">{t("noNginxSites")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                  <th className="text-left py-2 font-medium">{t("serviceName")}</th>
                  <th className="text-left py-2 font-medium">{t("nginxDomains")}</th>
                  <th className="text-left py-2 font-medium">{t("serviceStatus")}</th>
                  <th className="text-left py-2 font-medium">{t("nginxSSL")}</th>
                  <th className="text-right py-2 font-medium">{t("serviceActions")}</th>
                </tr>
              </thead>
              <tbody>
                {nginxSites.map((site: any) => (
                  <tr key={site.name} className="border-b border-[var(--border)]/50">
                    <td className="py-3 font-mono text-xs">{site.name}</td>
                    <td className="py-3 text-xs">{site.domains?.join(", ") || "\u2014"}</td>
                    <td className="py-3">
                      <span className={`flex items-center gap-1.5 text-xs ${site.enabled ? "text-emerald-500" : "text-gray-500"}`}>
                        <span className={`w-2 h-2 rounded-full ${site.enabled ? "bg-emerald-500" : "bg-gray-500"}`} />
                        {site.enabled ? t("nginxEnabled") : t("nginxDisabled")}
                      </span>
                    </td>
                    <td className="py-3">
                      {site.ssl ? <Lock size={14} className="text-emerald-500" /> : <Unlock size={14} className="text-[var(--muted)]" />}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => handleNginxToggle(site.name)} disabled={!!actionLoading} className={`px-2 py-1 text-xs rounded ${site.enabled ? "bg-red-500/10 text-red-500 hover:bg-red-500/20" : "bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20"}`}>
                          {actionLoading === `nginx-${site.name}` ? <Loader2 size={12} className="animate-spin" /> : (site.enabled ? t("serviceDisable") : t("serviceEnable"))}
                        </button>
                        <button onClick={() => handleNginxViewConfig(site.name)} className="px-2 py-1 text-xs bg-[var(--accent)]/10 text-[var(--accent)] rounded hover:bg-[var(--accent)]/20">
                          {t("nginxViewConfig")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* Nginx Config Modal */}
        {nginxConfigModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-3xl w-full max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">{t("nginxConfigFor")} {nginxConfigModal.name}</h3>
                <button onClick={() => setNginxConfigModal(null)} className="text-[var(--muted)] hover:text-[var(--foreground)]"><X size={18} /></button>
              </div>
              <pre className="flex-1 overflow-auto bg-[var(--background)] p-4 rounded-lg text-xs font-mono text-[var(--foreground)] whitespace-pre-wrap">{nginxConfigModal.config}</pre>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderDocker = () => {
    if (dockerLoading && !dockerContainers.length) return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
    return (
      <div className="space-y-6">
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("dockerContainers")}</h3>
            <button onClick={loadDocker} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
              <RefreshCw size={12} /> {t("refreshNow")}
            </button>
          </div>
          {dockerContainers.length === 0 ? (
            <p className="text-[var(--muted)] text-sm text-center py-8">{t("noDockerContainers")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                    <th className="text-left py-2 font-medium">{t("containerName")}</th>
                    <th className="text-left py-2 font-medium">{t("containerImage")}</th>
                    <th className="text-left py-2 font-medium">{t("containerStatus")}</th>
                    <th className="text-left py-2 font-medium">{t("containerCPU")}</th>
                    <th className="text-left py-2 font-medium">{t("containerMemory")}</th>
                    <th className="text-right py-2 font-medium">{t("containerActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dockerContainers.map((c: any) => (
                    <tr key={c.container_id} className="border-b border-[var(--border)]/50">
                      <td className="py-3">
                        <div className="font-mono text-xs">{c.name}</div>
                        <div className="text-[10px] text-[var(--muted)]">{c.container_id}</div>
                      </td>
                      <td className="py-3 font-mono text-xs max-w-[200px] truncate">{c.image}</td>
                      <td className="py-3">
                        <span className={`flex items-center gap-1.5 text-xs ${c.state === "running" ? "text-emerald-500" : c.state === "paused" ? "text-yellow-500" : "text-red-500"}`}>
                          <span className={`w-2 h-2 rounded-full ${c.state === "running" ? "bg-emerald-500" : c.state === "paused" ? "bg-yellow-500" : "bg-red-500"}`} />
                          {c.status}
                        </span>
                      </td>
                      <td className="py-3 font-mono text-xs">{c.cpu_percent}</td>
                      <td className="py-3">
                        <div className="font-mono text-xs">{c.mem_usage}</div>
                        <div className="text-[10px] text-[var(--muted)]">{c.mem_percent}</div>
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex gap-1 justify-end flex-wrap">
                          {c.state === "running" ? (
                            <>
                              <button disabled={!!actionLoading} onClick={() => handleDockerAction(c.container_id, "restart")} className="px-2 py-1 text-xs bg-orange-500/10 text-orange-500 rounded hover:bg-orange-500/20">
                                {actionLoading === `docker-${c.container_id}-restart` ? <Loader2 size={12} className="animate-spin" /> : t("containerRestart")}
                              </button>
                              <button disabled={!!actionLoading} onClick={() => handleDockerAction(c.container_id, "stop")} className="px-2 py-1 text-xs bg-red-500/10 text-red-500 rounded hover:bg-red-500/20">
                                {t("containerStop")}
                              </button>
                              <button disabled={!!actionLoading} onClick={() => handleDockerAction(c.container_id, "pause")} className="px-2 py-1 text-xs bg-yellow-500/10 text-yellow-500 rounded hover:bg-yellow-500/20">
                                {t("containerPause")}
                              </button>
                            </>
                          ) : c.state === "paused" ? (
                            <button disabled={!!actionLoading} onClick={() => handleDockerAction(c.container_id, "unpause")} className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-500 rounded hover:bg-emerald-500/20">
                              {t("containerUnpause")}
                            </button>
                          ) : (
                            <button disabled={!!actionLoading} onClick={() => handleDockerAction(c.container_id, "start")} className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-500 rounded hover:bg-emerald-500/20">
                              {t("containerStart")}
                            </button>
                          )}
                          <button onClick={() => handleDockerLogs(c.container_id, c.name)} className="px-2 py-1 text-xs bg-[var(--accent)]/10 text-[var(--accent)] rounded hover:bg-[var(--accent)]/20">
                            {t("containerLogs")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {/* Docker Log Modal */}
        {dockerLogModal && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-4xl w-full max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">{t("containerLogs")}: {dockerLogModal.name}</h3>
                <button onClick={() => setDockerLogModal(null)} className="text-[var(--muted)] hover:text-[var(--foreground)]"><X size={18} /></button>
              </div>
              <pre className="flex-1 overflow-auto bg-black p-4 rounded-lg text-xs font-mono text-green-400 whitespace-pre-wrap">{dockerLogModal.lines.join("\n")}</pre>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderNetwork = () => {
    return (
      <div className="space-y-6">
        {/* Resource Forecast */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2"><TrendingUp size={16} className="text-[var(--accent)]" /> {t("resourceForecast")}</h3>
            <button onClick={loadForecast} disabled={forecastLoading} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
              <RefreshCw size={12} className={forecastLoading ? "animate-spin" : ""} /> {t("refreshNow")}
            </button>
          </div>
          {forecastData?.forecasts?.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {forecastData.forecasts.map((f: any) => {
                const severityColors: Record<string, string> = { ok: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20", info: "text-blue-500 bg-blue-500/10 border-blue-500/20", warning: "text-yellow-500 bg-yellow-500/10 border-yellow-500/20", critical: "text-red-500 bg-red-500/10 border-red-500/20" };
                const colors = severityColors[f.severity] || severityColors.ok;
                return (
                  <div key={f.resource} className={`border rounded-xl p-4 ${colors}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold capitalize">{f.resource}</span>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-white/10">{f.severity === "ok" ? t("forecastOk") : f.severity === "info" ? t("forecastInfo") : f.severity === "warning" ? t("forecastWarning") : t("forecastCritical")}</span>
                    </div>
                    <div className="text-2xl font-bold mb-1">{f.current_percent.toFixed(1)}%</div>
                    <div className="text-xs opacity-80">{f.current_used} / {f.current_total}</div>
                    {f.days_until_full != null && (
                      <div className="mt-2 text-xs font-medium">{t("daysUntilFull")}: {f.days_until_full}d</div>
                    )}
                    <div className="mt-2 text-[10px] opacity-70">{f.recommendation}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-[var(--muted)] text-sm">
              {forecastLoading ? <Loader2 size={20} className="animate-spin mx-auto" /> : "No forecast data available"}
            </div>
          )}
        </div>

        {/* Network Overview */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("networkOverview")}</h3>
            <button onClick={loadNetwork} disabled={networkLoading} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
              <RefreshCw size={12} className={networkLoading ? "animate-spin" : ""} /> {t("refreshNow")}
            </button>
          </div>
          {networkData ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                  <div className="text-xs text-[var(--muted)]">{t("established")}</div>
                  <div className="text-2xl font-bold text-emerald-500">{networkData.established}</div>
                </div>
                <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                  <div className="text-xs text-[var(--muted)]">{t("listening")}</div>
                  <div className="text-2xl font-bold text-blue-500">{networkData.listening}</div>
                </div>
                <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                  <div className="text-xs text-[var(--muted)]">{t("timeWait")}</div>
                  <div className="text-2xl font-bold text-yellow-500">{networkData.time_wait}</div>
                </div>
                <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                  <div className="text-xs text-[var(--muted)]">{t("totalContainers")}</div>
                  <div className="text-2xl font-bold">{networkData.total_connections}</div>
                </div>
              </div>

              {/* Open Ports */}
              <h4 className="text-sm font-semibold mb-3">{t("openPorts")}</h4>
              {networkData.open_ports?.length ? (
                <table className="w-full text-sm mb-6">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                      <th className="text-left py-2 font-medium">{t("port")}</th>
                      <th className="text-left py-2 font-medium">{t("protocol")}</th>
                      <th className="text-left py-2 font-medium">{t("connectionProgram")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkData.open_ports.map((p: any, i: number) => (
                      <tr key={i} className="border-b border-[var(--border)]/50">
                        <td className="py-2 font-mono text-xs font-bold">{p.port}</td>
                        <td className="py-2 text-xs uppercase">{p.protocol}</td>
                        <td className="py-2 text-xs text-[var(--muted)]">{p.service || "\u2014"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-[var(--muted)] text-sm mb-6">No open ports detected</p>}

              {/* Active Connections (top 50) */}
              <h4 className="text-sm font-semibold mb-3">{t("activeConnections")}</h4>
              {networkData.connections?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                        <th className="text-left py-2 font-medium">{t("protocol")}</th>
                        <th className="text-left py-2 font-medium">{t("localAddress")}</th>
                        <th className="text-left py-2 font-medium">{t("foreignAddress")}</th>
                        <th className="text-left py-2 font-medium">{t("connectionState")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {networkData.connections.slice(0, 50).map((c: any, i: number) => (
                        <tr key={i} className="border-b border-[var(--border)]/50">
                          <td className="py-1.5 text-xs uppercase">{c.protocol}</td>
                          <td className="py-1.5 font-mono text-[11px]">{c.local_address}</td>
                          <td className="py-1.5 font-mono text-[11px]">{c.foreign_address}</td>
                          <td className="py-1.5">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${c.state === "ESTAB" ? "bg-emerald-500/10 text-emerald-500" : c.state === "LISTEN" ? "bg-blue-500/10 text-blue-500" : c.state === "TIME-WAIT" ? "bg-yellow-500/10 text-yellow-500" : "bg-gray-500/10 text-gray-500"}`}>
                              {c.state}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-[var(--muted)] text-sm">{t("noConnections")}</p>}
            </>
          ) : (
            <div className="text-center py-8 text-[var(--muted)] text-sm">
              {networkLoading ? <Loader2 size={20} className="animate-spin mx-auto" /> : "Click refresh to load network data"}
            </div>
          )}
        </div>

        {/* SSH Hardening */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2"><ShieldCheck size={16} /> {t("sshHardeningTitle")}</h3>
            <div className="flex gap-2">
              <button onClick={loadSshHardening} disabled={sshHardeningLoading} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
                <RefreshCw size={12} className={sshHardeningLoading ? "animate-spin" : ""} /> {t("refreshNow")}
              </button>
              <button onClick={handleSaveSshHardening} disabled={sshHardeningSaving || Object.keys(sshHardeningDirty).length === 0} className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {sshHardeningSaving && <Loader2 size={12} className="animate-spin" />}
                {t("save")}
              </button>
            </div>
          </div>
          {!sshHardening && !sshHardeningLoading && (
            <button onClick={loadSshHardening} className="w-full py-4 text-sm text-[var(--accent)] hover:underline">Load SSH hardening status</button>
          )}
          {sshHardeningLoading && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[var(--accent)]" /></div>}
          {sshHardening && (
            <>
              <div className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2 mb-4">
                {t("sshHardeningWarning")}
              </div>
              <div className="space-y-4">
                {[
                  { key: "password_auth", label: t("sshPasswordAuth"), desc: t("sshPasswordAuthDesc"), type: "toggle" as const },
                  { key: "root_login", label: t("sshRootLogin"), desc: t("sshRootLoginDesc"), type: "select" as const, options: ["yes", "no", "prohibit-password"] },
                  { key: "permit_empty_passwords", label: t("sshEmptyPasswords"), desc: t("sshEmptyPasswordsDesc"), type: "toggle" as const },
                  { key: "max_auth_tries", label: t("sshMaxAuthTries"), desc: t("sshMaxAuthTriesDesc"), type: "number" as const, min: 1, max: 20 },
                  { key: "x11_forwarding", label: t("sshX11Forwarding"), desc: t("sshX11ForwardingDesc"), type: "toggle" as const },
                  { key: "allow_tcp_forwarding", label: t("sshTcpForwarding"), desc: t("sshTcpForwardingDesc"), type: "toggle" as const },
                  { key: "client_alive_interval", label: t("sshKeepAlive"), desc: t("sshKeepAliveDesc"), type: "number" as const, min: 0, max: 3600 },
                ].map(field => {
                  const currentVal = sshHardeningDirty[field.key] !== undefined ? sshHardeningDirty[field.key] : sshHardening[field.key];
                  return (
                    <div key={field.key} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                      <div>
                        <div className="text-sm font-medium">{field.label}</div>
                        <div className="text-xs text-[var(--muted)] mt-0.5">{field.desc}</div>
                      </div>
                      {field.type === "toggle" ? (
                        <Toggle checked={typeof currentVal === "boolean" ? currentVal : currentVal === "yes"} onChange={(v) => setSshHardeningDirty(prev => ({...prev, [field.key]: v}))} />
                      ) : field.type === "select" ? (
                        <select value={currentVal} onChange={e => setSshHardeningDirty(prev => ({...prev, [field.key]: e.target.value}))} className="px-3 py-1.5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-xs">
                          {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input type="number" value={currentVal} min={field.min} max={field.max} onChange={e => setSshHardeningDirty(prev => ({...prev, [field.key]: parseInt(e.target.value) || 0}))} className="w-20 px-2 py-1.5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-xs text-center" />
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Swap Management */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">{t("swapManagement")}</h3>
            <button onClick={loadSwap} disabled={swapLoading} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1">
              <RefreshCw size={12} className={swapLoading ? "animate-spin" : ""} /> {t("refreshNow")}
            </button>
          </div>
          {!swapData && !swapLoading && (
            <button onClick={loadSwap} className="w-full py-4 text-sm text-[var(--accent)] hover:underline">Load swap information</button>
          )}
          {swapLoading && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[var(--accent)]" /></div>}
          {swapData && (
            <>
              {swapData.total_mb > 0 ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                      <div className="text-xs text-[var(--muted)]">{t("swapTotal")}</div>
                      <div className="text-lg font-bold">{formatBytes(swapData.total_mb)}</div>
                    </div>
                    <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                      <div className="text-xs text-[var(--muted)]">{t("swapUsed")}</div>
                      <div className="text-lg font-bold">{formatBytes(swapData.used_mb)}</div>
                    </div>
                    <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                      <div className="text-xs text-[var(--muted)]">{t("swapFree")}</div>
                      <div className="text-lg font-bold">{formatBytes(swapData.free_mb)}</div>
                    </div>
                    <div className="text-center p-3 bg-[var(--background)] rounded-lg">
                      <div className="text-xs text-[var(--muted)]">{t("swappiness")}</div>
                      <div className="text-lg font-bold">{swapData.swappiness}</div>
                    </div>
                  </div>
                  <ProgressBar value={swapData.percent} label={t("swapUsage")} sublabel={`${swapData.percent}%`} color="#f59e0b" />
                  <button onClick={handleRemoveSwap} className="px-3 py-1.5 text-xs bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20">
                    {t("removeSwap")}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-[var(--muted)] text-sm">{t("noSwap")}</p>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-[var(--muted)]">{t("swapSizeMB")}:</label>
                    <select value={swapCreateSize} onChange={e => setSwapCreateSize(parseInt(e.target.value))} className="px-3 py-1.5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-xs">
                      <option value={512}>512 MB</option>
                      <option value={1024}>1 GB</option>
                      <option value={2048}>2 GB</option>
                      <option value={4096}>4 GB</option>
                      <option value={8192}>8 GB</option>
                    </select>
                    <button onClick={handleCreateSwap} disabled={actionLoading === "create-swap"} className="px-4 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                      {actionLoading === "create-swap" && <Loader2 size={12} className="animate-spin" />}
                      {t("createSwap")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Quick Actions */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2"><Wrench size={16} /> {t("quickActions")}</h3>
              <p className="text-xs text-[var(--muted)] mt-1">{t("quickActionsDesc")}</p>
            </div>
            {!quickActions.length && !quickActionsLoading && (
              <button onClick={loadQuickActions} className="text-xs text-[var(--accent)] hover:underline">Load actions</button>
            )}
          </div>
          {quickActionsLoading && <div className="flex justify-center py-4"><Loader2 size={20} className="animate-spin text-[var(--accent)]" /></div>}
          {quickActions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {quickActions.map((qa: any) => (
                <div key={qa.id} className={`border rounded-lg p-3 flex items-center justify-between ${qa.danger ? "border-red-500/20" : "border-[var(--border)]"}`}>
                  <div>
                    <div className="text-sm font-medium flex items-center gap-2">
                      {qa.label}
                      {qa.danger && <span className="text-[10px] px-1.5 py-0.5 bg-red-500/10 text-red-500 rounded-full">{t("quickActionDanger")}</span>}
                    </div>
                    <div className="text-xs text-[var(--muted)] mt-0.5">{qa.description}</div>
                  </div>
                  <button onClick={() => handleQuickAction(qa.id)} disabled={quickActionRunning === qa.id} className={`px-3 py-1.5 text-xs rounded-lg flex items-center gap-1.5 ${qa.danger ? "bg-red-500/10 text-red-500 hover:bg-red-500/20" : "bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20"}`}>
                    {quickActionRunning === qa.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                    Run
                  </button>
                </div>
              ))}
            </div>
          )}
          {quickActionResult && (
            <div className="mt-4 bg-[var(--background)] rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">Output: {quickActionResult.action}</span>
                <button onClick={() => setQuickActionResult(null)} className="text-[var(--muted)] hover:text-[var(--foreground)]"><X size={14} /></button>
              </div>
              <pre className="text-xs font-mono text-[var(--muted)] whitespace-pre-wrap">{quickActionResult.output}</pre>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Tab content map
  const tabContent: Record<TabId, () => React.ReactNode> = {
    dashboard: renderDashboard,
    monitoring: renderMonitoring,
    instances: renderInstances,
    services: renderServices,
    security: renderSecurity,
    postgresql: renderPostgreSQL,
    cron: renderCron,
    logs: renderLogs,
    sshkeys: renderSshKeys,
    settings: renderSettings,
    upgrade: renderUpgrade,
    nginx: renderNginx,
    docker: renderDocker,
    network: renderNetwork,
  };

  // ═══════════════════════════════════════════════════════════════
  // PAGE LAYOUT
  // ═══════════════════════════════════════════════════════════════

  return (
    <AuthGuard>
      <div className="flex h-screen bg-[var(--background)]">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            {/* Toast */}
            {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

            {/* Confirm Modal */}
            {confirmModal && (
              <ConfirmModal
                title={confirmModal.title}
                message={confirmModal.message}
                danger={confirmModal.danger}
                loading={confirmLoading}
                onConfirm={executeConfirm}
                onCancel={() => setConfirmModal(null)}
              />
            )}

            {/* Header */}
            <div className="mb-6">
              <button onClick={() => router.push("/")} className="flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)] mb-4">
                <ArrowLeft size={16} /> {t("back")}
              </button>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-[var(--accent)]/10 rounded-xl flex items-center justify-center">
                    <Server size={20} className="text-[var(--accent)]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h1 className="text-xl font-bold text-[var(--foreground)]">{server.name}</h1>
                      <span className={`flex items-center gap-1.5 text-xs px-2.5 py-0.5 rounded-full ${statusBg[server.status] || "bg-gray-500"}/20 ${statusColors[server.status] || "text-gray-500"}`}>
                        <span className={`w-2 h-2 rounded-full ${statusBg[server.status] || "bg-gray-500"}`} />
                        {t(server.status === "online" ? "online" : server.status === "offline" ? "offline" : server.status === "provisioning" ? "provisioning" : "errorStatus")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-[var(--muted)] mt-1">
                      <span className="flex items-center gap-1"><Globe size={12} /> {server.endpoint}</span>
                      <span className="capitalize">{server.provider}</span>
                      {server.region && <span className="flex items-center gap-1"><MapPin size={11} /> {server.region}</span>}
                      {specs?.os && <span>{specs.os}</span>}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={handleRefreshSpecs} disabled={actionLoading === "specs"} className="px-3 py-2 bg-[var(--card)] border border-[var(--border)] rounded-lg text-xs flex items-center gap-1.5 hover:bg-[var(--card-hover)]">
                    {actionLoading === "specs" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {t("refreshSpecs")}
                  </button>
                  <button onClick={handleReboot} className="px-3 py-2 bg-orange-500/10 text-orange-500 border border-orange-500/20 rounded-lg text-xs flex items-center gap-1.5 hover:bg-orange-500/20">
                    <Power size={12} /> {t("rebootServer")}
                  </button>
                </div>
              </div>
            </div>

            {/* Tab Navigation */}
            <div className="border-b border-[var(--border)] mb-6">
              <div className="flex gap-6 overflow-x-auto pb-px">
                {TAB_GROUPS.map(group => (
                  <div key={group.label} className="flex gap-1">
                    {group.tabs.map(tab => {
                      const Icon = tab.icon;
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => handleTabChange(tab.id)}
                          className={`flex items-center gap-1.5 px-3 py-2.5 text-xs whitespace-nowrap border-b-2 transition-colors ${
                            isActive
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
                ))}
              </div>
            </div>

            {/* Tab Content */}
            {tabContent[activeTab]?.()}
          </main>
        </div>
        <VitoChat />
      </div>
    </AuthGuard>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────

function SecurityItem({ label, ok, detail }: { label: string; ok?: boolean; detail?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-red-500" />}
        <span className="text-sm">{label}</span>
      </div>
      {detail && <span className="text-xs text-[var(--muted)]">{detail}</span>}
    </div>
  );
}

function ResourceBarsInline({ serverId }: { serverId: string }) {
  const [metrics, setMetrics] = useState<any>(null);
  const t = useTranslations("serverDetail");

  useEffect(() => {
    serversApi.metrics(serverId).then(setMetrics).catch(() => {});
    const interval = setInterval(() => {
      serversApi.metrics(serverId).then(setMetrics).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, [serverId]);

  if (!metrics) return <div className="text-sm text-[var(--muted)]">{t("loading")}</div>;

  return (
    <div className="space-y-3">
      <ProgressBar value={metrics.cpu_percent} label={t("cpuUsage")} sublabel={`${metrics.cpu_percent}%`} color="#f59e0b" />
      <ProgressBar value={metrics.ram_percent} label={t("memoryUsage")} sublabel={`${metrics.ram_percent}%`} color="#f59e0b" />
      <ProgressBar value={metrics.disk_percent} label={t("diskUsage")} sublabel={`${metrics.disk_percent}%`} color="#22c55e" />
      <div className="flex justify-between text-xs text-[var(--muted)] pt-2">
        <span>{t("uptimeLabel")}: {metrics.uptime}</span>
        <span>{t("loadAverage")}: {metrics.load_avg}</span>
      </div>
    </div>
  );
}
