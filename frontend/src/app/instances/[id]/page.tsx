"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { LogViewer } from "@/components/dashboard/LogViewer";
import { instancesApi, backupsApi, serversApi, settingsApi, githubApi, migrationsApi, clonesApi, backupSchedulesApi, databaseApi } from "@/lib/api";
import DatabaseExplorer from "@/components/dashboard/DatabaseExplorer";
import {
  ArrowLeft, Play, Square, RotateCcw, Trash2, ExternalLink,
  Cpu, MemoryStick, Users, Heart, ScrollText, Database,
  Loader2, CheckCircle, XCircle, AlertTriangle, Clock,
  RefreshCw, Plus, ChevronDown, ChevronUp, Globe,
  LayoutDashboard, Settings2, Puzzle, GitBranch, Activity, Wrench,
  Eye, EyeOff, Copy, Shield, Bell, BellOff, Calendar,
  Save, ArrowUpDown, Gauge, HardDrive, Zap,
  Package, Library, GitCommit, Search, X, ChevronRight, BookOpen,
  ShoppingBag, Download, ChevronLeft, Store, Github, Upload, Link2, Unlink2,
  Mail, Code, Languages, FolderOpen, RotateCw, Sparkles, Lock,
  FileText, Filter, Undo2, Terminal, Network, ArrowUp, ArrowDown,
  Timer, Wifi, WifiOff, CircleDot, History, TrendingUp, Server, Layers, Power, Table2
} from "lucide-react";

type TabId = "dashboard" | "logs" | "backups" | "config" | "addons" | "marketplace" | "staging" | "monitoring" | "migration" | "clones" | "schedules" | "settings" | "database";

function getTabGroups(t: (key: string) => string): { label: string; tabs: { id: TabId; label: string; icon: typeof LayoutDashboard }[] }[] {
  return [
    {
      label: t("tabGroupOverview"),
      tabs: [
        { id: "dashboard", label: t("tabDashboard"), icon: LayoutDashboard },
        { id: "logs", label: t("tabLogs"), icon: ScrollText },
        { id: "monitoring", label: t("tabMonitoring"), icon: Activity },
      ],
    },
    {
      label: t("tabGroupData"),
      tabs: [
        { id: "database", label: t("tabDatabase"), icon: Table2 },
        { id: "backups", label: t("tabBackups"), icon: Database },
        { id: "schedules", label: t("tabSchedules"), icon: Calendar },
        { id: "migration", label: t("tabMigration"), icon: ArrowUpDown },
      ],
    },
    {
      label: t("tabGroupEnvironment"),
      tabs: [
        { id: "staging", label: t("tabStaging"), icon: GitBranch },
        { id: "clones", label: t("tabClones"), icon: Layers },
        { id: "config", label: t("tabConfig"), icon: Settings2 },
      ],
    },
    {
      label: t("tabGroupExtensions"),
      tabs: [
        { id: "addons", label: t("tabAddons"), icon: Puzzle },
        { id: "marketplace", label: t("tabMarketplace"), icon: Store },
        { id: "settings", label: t("tabSettings"), icon: Wrench },
      ],
    },
  ];
}

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

function SettingToggle({ label, description, checked, onChange, disabled = false, loading = false }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; loading?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <div className={`flex items-center justify-between py-3 border-b border-white/5 last:border-0 ${isDisabled ? "opacity-50" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="text-white font-medium flex items-center gap-2">
          {label}
          {loading && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
        </div>
        <div className="text-gray-400 text-sm mt-0.5">{description}</div>
      </div>
      <button
        onClick={() => !isDisabled && onChange(!checked)}
        disabled={isDisabled}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ml-3 ${checked ? "bg-emerald-500" : "bg-gray-600"} ${isDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${checked ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}

export default function InstanceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations("instanceDetail");
  const tCommon = useTranslations("common");
  const instanceId = params.id as string;

  const TAB_GROUPS = useMemo(() => getTabGroups(t), [t]);
  const TABS = useMemo(() => TAB_GROUPS.flatMap(g => g.tabs), [TAB_GROUPS]);

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

  // Config state (legacy simple form)
  const [configForm, setConfigForm] = useState({
    name: "",
    domain: "",
    workers: 2,
    ram_mb: 1024,
    auto_restart: true,
  });
  const [configSaving, setConfigSaving] = useState(false);

  // Odoo Config (odoo.conf) state — enterprise editor
  const [odooConfig, setOdooConfig] = useState<Record<string, any>>({});
  const [odooConfigDirty, setOdooConfigDirty] = useState<Record<string, any>>({});
  const [odooSchema, setOdooSchema] = useState<Record<string, any>>({});
  const [odooSections, setOdooSections] = useState<Record<string, any>>({});
  const [odooPresets, setOdooPresets] = useState<Record<string, any>>({});
  const [odooReadonly, setOdooReadonly] = useState<string[]>([]);
  const [odooConfigLoading, setOdooConfigLoading] = useState(false);
  const [odooConfigSaving, setOdooConfigSaving] = useState(false);
  const [odooShowAll, setOdooShowAll] = useState(false);
  const [odooExpandedSections, setOdooExpandedSections] = useState<Set<string>>(new Set(["database", "performance", "network"]));
  const [odooSearchFilter, setOdooSearchFilter] = useState("");
  const [odooShowPasswords, setOdooShowPasswords] = useState<Set<string>>(new Set());
  const [odooPresetApplying, setOdooPresetApplying] = useState<string | null>(null);
  const [odooConfigError, setOdooConfigError] = useState<string | null>(null);
  const [odooConfigSuccess, setOdooConfigSuccess] = useState<string | null>(null);

  // Monitoring state (real-time metrics)
  const [monitoringData, setMonitoringData] = useState<any>(null);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [quickMetrics, setQuickMetrics] = useState<any>(null);
  const [quickMetricsLoading, setQuickMetricsLoading] = useState(false);

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

  // GitHub repo browser state
  const [showGithubReposModal, setShowGithubReposModal] = useState(false);
  const [ghRepos, setGhRepos] = useState<any[]>([]);
  const [ghReposLoading, setGhReposLoading] = useState(false);
  const [ghRepoSearch, setGhRepoSearch] = useState("");
  const [ghRepoSearchDebounce, setGhRepoSearchDebounce] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [ghBranches, setGhBranches] = useState<{ name: string; protected: boolean }[]>([]);
  const [ghSelectedRepo, setGhSelectedRepo] = useState<any>(null);
  const [ghSelectedBranch, setGhSelectedBranch] = useState("");
  const [ghAddingRepo, setGhAddingRepo] = useState(false);
  const [showUploadGithubModal, setShowUploadGithubModal] = useState(false);
  const [ghUploadRepoName, setGhUploadRepoName] = useState("");
  const [ghUploadRepoDesc, setGhUploadRepoDesc] = useState("");
  const [ghUploading, setGhUploading] = useState(false);

  // Marketplace state
  const [mpModules, setMpModules] = useState<any[]>([]);
  const [mpTotal, setMpTotal] = useState(0);
  const [mpTotalPages, setMpTotalPages] = useState(1);
  const [mpCategories, setMpCategories] = useState<string[]>([]);
  const [mpSearch, setMpSearch] = useState("");
  const [mpCategory, setMpCategory] = useState("");
  const [mpSource, setMpSource] = useState("");
  const [mpSources, setMpSources] = useState<string[]>([]);
  const [mpPage, setMpPage] = useState(1);
  const [mpLoading, setMpLoading] = useState(false);
  const [mpInstalling, setMpInstalling] = useState<string | null>(null);
  const [mpBuilding, setMpBuilding] = useState(false);
  const [mpSearchDebounce, setMpSearchDebounce] = useState<ReturnType<typeof setTimeout> | null>(null);

  // GitHub OAuth state
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUsername, setGithubUsername] = useState("");
  const [githubAvatar, setGithubAvatar] = useState("");

  // Staging action state (data comes from clones list)
  const [stagingAction, setStagingAction] = useState<string | null>(null);

  // Enterprise Migration state
  const [migrations, setMigrations] = useState<any[]>([]);
  const [migrationsLoading, setMigrationsLoading] = useState(false);
  const [migrationEstimate, setMigrationEstimate] = useState<any>(null);
  const [migrationForm, setMigrationForm] = useState({ target_server_id: "", include_filestore: true, target_database: "" });
  const [migrationAction, setMigrationAction] = useState<string | null>(null);
  const [servers, setServers] = useState<any[]>([]);

  // Enterprise Clones state
  const [clones, setClones] = useState<any[]>([]);
  const [clonesLoading, setClonesLoading] = useState(false);
  const [cloneAction, setCloneAction] = useState<string | null>(null);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneForm, setCloneForm] = useState({ clone_type: "staging", name: "", neutralize: true, base_url: "" });

  // Enterprise Backup Schedules state
  const [schedules, setSchedules] = useState<any[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({
    cron_expression: "0 2 * * *", timezone: "Europe/Rome", backup_format: "zip",
    include_filestore: true, keep_daily: 7, keep_weekly: 4, keep_monthly: 12,
    notify_on_success: false, notify_on_failure: true, verify_after_backup: true,
    stop_instance_during_backup: false,
  });
  const [scheduleAction, setScheduleAction] = useState<string | null>(null);

  // Backups schedule state
  const [backupSchedule, setBackupSchedule] = useState({
    enabled: true,
    frequency: "daily",
    retention_days: 30,
  });

  // Backup/Restore dialog state
  const [backupDialog, setBackupDialog] = useState<{ includeFilestore: boolean } | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<{ backupId: string; includeFilestore: boolean; hasFilestore: boolean } | null>(null);

  // Settings state
  const [settingsForm, setSettingsForm] = useState({
    auto_backup: true,
    backup_schedule: "daily",
    notify_on_error: true,
    notify_on_backup: false,
    notify_on_resources: false,
    notify_ssl_expiry: true,
  });
  const [showDomainModal, setShowDomainModal] = useState(false);
  const [domainForm, setDomainForm] = useState({ domain: "", aliases: [] as string[], http_redirect: true });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [enterpriseBusy, setEnterpriseBusy] = useState(false);
  const [enterpriseToast, setEnterpriseToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
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
      setLogs([t("logsFailedLoad")]);
    }
  }, [instanceId, logLines]);

  const loadOdooConfig = useCallback(async (showAll?: boolean) => {
    setOdooConfigLoading(true);
    setOdooConfigError(null);
    try {
      const data = await instancesApi.getOdooConfig(instanceId, showAll ?? odooShowAll);
      setOdooConfig(data.params || {});
      setOdooConfigDirty({});
      setOdooSchema(data.schema || {});
      setOdooSections(data.sections || {});
      setOdooPresets(data.presets || {});
      setOdooReadonly(data.readonly_params || []);
    } catch (err: any) {
      setOdooConfigError(err.message || t("configFailedLoad"));
    } finally {
      setOdooConfigLoading(false);
    }
  }, [instanceId, odooShowAll]);

  const loadMonitoring = useCallback(async () => {
    setMonitoringLoading(true);
    try {
      const data = await instancesApi.getMonitoring(instanceId);
      setMonitoringData(data);
    } catch { setMonitoringData(null); }
    finally { setMonitoringLoading(false); }
  }, [instanceId]);

  const loadQuickMetrics = useCallback(async () => {
    setQuickMetricsLoading(true);
    try {
      const data = await instancesApi.getQuickMetrics(instanceId);
      setQuickMetrics(data);
    } catch { setQuickMetrics(null); }
    finally { setQuickMetricsLoading(false); }
  }, [instanceId]);

  useEffect(() => {
    loadInstance();
    try { settingsApi.listEnterprise().then(setEnterprisePackages).catch(() => {}); } catch {}
  }, [loadInstance]);

  useEffect(() => {
    if (instance && instance.status === "running") {
      loadHealth();
      loadQuickMetrics();
    }
  }, [instance, loadHealth]);


  const loadMigrations = useCallback(async () => {
    setMigrationsLoading(true);
    try {
      const data = await migrationsApi.list();
      setMigrations(data.filter((m: any) => m.source_instance_id === instanceId));
    } catch { setMigrations([]); }
    finally { setMigrationsLoading(false); }
  }, [instanceId]);

  const loadClones = useCallback(async () => {
    setClonesLoading(true);
    try {
      const data = await clonesApi.list(instanceId);
      setClones(data);
    } catch { setClones([]); }
    finally { setClonesLoading(false); }
  }, [instanceId]);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const data = await backupSchedulesApi.list(instanceId);
      setSchedules(data);
    } catch { setSchedules([]); }
    finally { setSchedulesLoading(false); }
  }, [instanceId]);

  const loadServers = useCallback(async () => {
    try {
      const data = await serversApi.list();
      setServers(data);
    } catch { setServers([]); }
  }, []);

  const loadAddons = useCallback(async () => {
    setAddonsLoading(true);
    try {
      const data = await instancesApi.listAddons(instanceId);
      setAddons(data);
    } catch { setAddons([]); }
    finally { setAddonsLoading(false); }
  }, [instanceId]);

  const loadMarketplace = useCallback(async (search?: string, category?: string, page?: number, source?: string) => {
    setMpLoading(true);
    try {
      const data = await instancesApi.getMarketplace(instanceId, {
        search: search ?? mpSearch,
        category: category ?? mpCategory,
        source: source ?? mpSource,
        page: page ?? mpPage,
        per_page: 24,
      });
      if (data.building) {
        setMpBuilding(true);
        setMpModules([]);
        setMpTotal(0);
        // Auto-retry after 10 seconds while index is building
        setTimeout(() => loadMarketplace(search, category, page, source), 10000);
      } else {
        setMpBuilding(false);
        setMpModules(data.modules || []);
        setMpTotal(data.total || 0);
        setMpTotalPages(data.total_pages || 1);
        if (data.categories) setMpCategories(data.categories);
        if (data.sources) setMpSources(data.sources);
      }
    } catch { setMpModules([]); }
    finally { setMpLoading(false); }
  }, [instanceId, mpSearch, mpCategory, mpSource, mpPage]);

  const loadGithubStatus = useCallback(async () => {
    try {
      const data = await githubApi.status();
      setGithubConnected(data.connected);
      setGithubUsername(data.username || "");
      setGithubAvatar(data.avatar_url || "");
    } catch { setGithubConnected(false); }
  }, []);

  useEffect(() => {
    if (activeTab === "logs") {
      loadLogs();
    }
    if (activeTab === "config") {
      loadOdooConfig();
    }
    if (activeTab === "addons") {
      loadAddons();
      loadGithubStatus();
    }
    if (activeTab === "monitoring") {
      loadMonitoring();
    }
    if (activeTab === "marketplace") {
      loadMarketplace();
      loadGithubStatus();
    }
    if (activeTab === "staging") {
      loadClones();
    }
    if (activeTab === "migration") {
      loadMigrations();
      loadServers();
    }
    if (activeTab === "clones") {
      loadClones();
    }
    if (activeTab === "schedules") {
      loadSchedules();
    }
  }, [activeTab, loadLogs, loadAddons, loadMarketplace, loadGithubStatus, loadMigrations, loadClones, loadSchedules, loadServers]);

  // Auto-refresh for instances in transitional states
  const busyStatuses = ["deploying", "upgrading", "backing_up", "migrating", "cloning"];
  const isBusy = instance?.status && busyStatuses.includes(instance.status);
  useEffect(() => {
    if (isBusy) {
      const interval = setInterval(loadInstance, 4000);
      return () => clearInterval(interval);
    }
  }, [isBusy, loadInstance]);

  // Auto-refresh backups when any are in progress
  const hasActiveBackup = backups.some((b: any) => b.status === "pending" || b.status === "in_progress");
  useEffect(() => {
    if (hasActiveBackup) {
      const interval = setInterval(loadInstance, 3000);
      return () => clearInterval(interval);
    }
  }, [hasActiveBackup, loadInstance]);

  // Auto-refresh clones when any are in transitional state
  const hasActiveClone = clones.some((c: any) => ["cloning", "neutralizing"].includes(c.status));
  useEffect(() => {
    if (hasActiveClone) {
      const interval = setInterval(loadClones, 3000);
      return () => clearInterval(interval);
    }
  }, [hasActiveClone, loadClones]);

  // Auto-refresh addons when any are installing/cloning
  const hasActiveAddon = addons.some((a: any) => ["pending", "cloning", "upgrading"].includes(a.status));
  useEffect(() => {
    if (hasActiveAddon) {
      const interval = setInterval(loadAddons, 3000);
      return () => clearInterval(interval);
    }
  }, [hasActiveAddon, loadAddons]);

  // Auto-refresh migrations when any are active
  const hasActiveMigration = migrations.some((m: any) => !["completed", "failed", "rolled_back"].includes(m.status));
  useEffect(() => {
    if (hasActiveMigration) {
      const interval = setInterval(() => { loadMigrations(); loadInstance(); }, 4000);
      return () => clearInterval(interval);
    }
  }, [hasActiveMigration, loadMigrations, loadInstance]);

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
    if (!confirm(t("confirmDeleteInstance", { name: instance?.name }))) return;
    setActionLoading("delete");
    try {
      await instancesApi.remove(instanceId);
      router.push("/instances");
    } catch (err: any) {
      alert(err.message);
      setActionLoading(null);
    }
  }

  function handleCreateBackup() {
    setBackupDialog({ includeFilestore: true });
  }

  async function confirmCreateBackup() {
    if (!backupDialog) return;
    setActionLoading("backup");
    const includeFs = backupDialog.includeFilestore;
    setBackupDialog(null);
    try {
      await backupsApi.create(instanceId, includeFs);
      await loadInstance();
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading(null);
  }

  async function handleCancelBackup(backupId: string) {
    if (!confirm(t("backupConfirmCancel"))) return;
    setActionLoading(`cancel-bkp-${backupId}`);
    try {
      await backupsApi.cancel(backupId);
      await loadInstance();
    } catch (err: any) { alert(err.message); }
    finally { setActionLoading(null); }
  }

  function handleRestore(backupId: string) {
    const bkp = backups.find(b => b.id === backupId);
    const hasFilestore = bkp?.include_filestore !== false;
    setRestoreDialog({ backupId, includeFilestore: hasFilestore, hasFilestore });
  }

  async function confirmRestore() {
    if (!restoreDialog) return;
    setActionLoading(`restore-${restoreDialog.backupId}`);
    setRestoreDialog(null);
    try {
      await backupsApi.restore(restoreDialog.backupId, restoreDialog.includeFilestore);
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

  const handleSaveSettings = async (key: string, value: boolean | string) => {
    // Enterprise toggle: confirm + poll for progress
    if (key === "enterprise" && value) {
      if (!confirm(t("confirmEnableEnterprise"))) return;
    }
    if (key === "enterprise" && !value) {
      if (!confirm(t("confirmDisableEnterprise"))) return;
    }

    setSettingsSaving(true);
    if (key === "enterprise") {
      setEnterpriseBusy(true);
      setEnterpriseToast(null);
    }
    try {
      await instancesApi.updateSettings(instanceId, { [key]: value });
      // For enterprise enable/disable, poll until status returns to "running"
      if (key === "enterprise") {
        const enabling = !!value;
        const poll = setInterval(async () => {
          try {
            const data = await instancesApi.get(instanceId);
            setInstance(data);
            if (data.status !== "upgrading") {
              clearInterval(poll);
              setSettingsSaving(false);
              setEnterpriseBusy(false);
              // Show feedback toast
              const hasError = data.config?.enterprise_error;
              if (hasError) {
                setEnterpriseToast({ type: "error", message: data.config.enterprise_error });
              } else {
                setEnterpriseToast({
                  type: "success",
                  message: enabling ? t("enterpriseEnabledSuccess") : t("enterpriseDisabledSuccess"),
                });
              }
              // Auto-dismiss toast after 5s
              setTimeout(() => setEnterpriseToast(null), 5000);
            }
          } catch {}
        }, 2000);
        return; // Don't setSettingsSaving(false) yet
      }
      await loadInstance();
    } catch (e: any) {
      setEnterpriseBusy(false);
      alert(e.message || t("settingsFailedSave"));
    } finally {
      if (key !== "enterprise") setSettingsSaving(false);
    }
  };

  const handleSaveDomain = async () => {
    try {
      await instancesApi.updateDomain(instanceId, domainForm);
      setShowDomainModal(false);
      await loadInstance();
    } catch (e: any) {
      alert(e.message || t("settingsFailedSaveDomain"));
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
    if (backups.length === 0) return { date: t("backupNever"), ago: "" };
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
                    {server && <> {t("onServer", { server: server.name })}</>}
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
                        {actionLoading === "restart" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} {t("restart")}
                      </button>
                      <button
                        onClick={() => handleAction("stop")}
                        disabled={!!actionLoading}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--card)] border border-[var(--border)] hover:bg-[var(--card-hover)] transition-colors flex items-center gap-2 text-[var(--warning)] disabled:opacity-50"
                      >
                        {actionLoading === "stop" ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />} {t("stop")}
                      </button>
                    </>
                  )}
                  {instance.status === "stopped" && (
                    <button
                      onClick={() => handleAction("start")}
                      disabled={!!actionLoading}
                      className="px-3 py-2 text-sm rounded-lg bg-[var(--success)]/10 text-[var(--success)] hover:bg-[var(--success)]/20 transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      {actionLoading === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {t("start")}
                    </button>
                  )}
                </div>
              </div>

              {/* Tab Navigation — Grouped compact */}
              <div className="mb-6 bg-[var(--card)] border border-[var(--border)] rounded-xl p-1.5">
                <div className="grid grid-cols-4 gap-1">
                  {TAB_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="text-[10px] font-medium text-[var(--muted)] uppercase tracking-wider px-2 py-1">{group.label}</div>
                      <div className="flex flex-col gap-0.5">
                        {group.tabs.map((tab) => {
                          const Icon = tab.icon;
                          return (
                            <button
                              key={tab.id}
                              onClick={() => setActiveTab(tab.id)}
                              className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1.5 ${
                                activeTab === tab.id
                                  ? "bg-[var(--accent)]/15 text-[var(--accent)] shadow-sm"
                                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5"
                              }`}
                            >
                              <Icon size={13} className="shrink-0" />
                              {tab.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ========== DASHBOARD TAB — Operations Center ========== */}
              {activeTab === "dashboard" && (() => {
                const qm = quickMetrics;
                const cpuNum = qm?.cpu ? parseFloat(qm.cpu) : 0;
                const memNum = qm?.memory_percent ? parseFloat(qm.memory_percent) : 0;
                const rtMs = qm?.response_time_ms;
                const isOnline = instance.status === "running";

                return (
                  <div className="space-y-4">
                    {/* Hero Status Bar */}
                    <div className={`rounded-xl p-5 border ${isOnline ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                      <div className="flex items-center justify-between flex-wrap gap-4">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isOnline ? "bg-emerald-500/10" : "bg-red-500/10"}`}>
                            {isOnline ? <Wifi size={22} className="text-emerald-400" /> : <WifiOff size={22} className="text-red-400" />}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`w-2.5 h-2.5 rounded-full ${isOnline ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
                              <span className="text-lg font-semibold">{isOnline ? t("dashboardOnline") : instance.status === "deploying" ? t("dashboardDeploying") : t("dashboardOffline")}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] font-medium">
                                Odoo {instance.version} {instance.config?.enterprise ? t("enterprise") : t("community")}
                              </span>
                            </div>
                            <p className="text-xs text-[var(--muted)] mt-0.5">
                              {isOnline && qm?.started_at ? t("dashboardUpSince", { date: new Date(qm.started_at).toLocaleString("it-IT") }) :
                               isOnline ? t("dashboardUptime", { time: formatUptime(instance.started_at || instance.created_at) }) :
                               t("dashboardNotRunning")}
                              {qm?.restart_count > 0 && <span className="text-amber-400 ml-2">{t("dashboardRestarts", { count: qm.restart_count })}</span>}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {instance.domain && (
                            <a href={instance.url || `https://${instance.domain}`} target="_blank" rel="noopener"
                              className="px-3 py-2 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors flex items-center gap-1.5">
                              <ExternalLink size={12} /> {t("dashboardOpenOdoo")}
                            </a>
                          )}
                          <button onClick={() => { loadHealth(); loadQuickMetrics(); }}
                            className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors"
                            title={t("dashboardRefreshMetrics")}>
                            <RefreshCw size={14} className={quickMetricsLoading ? "animate-spin" : ""} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Live Metrics Strip */}
                    {isOnline && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {/* CPU */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-[var(--muted)] flex items-center gap-1"><Cpu size={12} /> {t("dashboardCpu")}</span>
                            <span className={`text-sm font-semibold ${cpuNum > 85 ? "text-red-400" : cpuNum > 60 ? "text-amber-400" : "text-emerald-400"}`}>
                              {qm?.cpu || "—"}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-[var(--background)] rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${cpuNum > 85 ? "bg-red-400" : cpuNum > 60 ? "bg-amber-400" : "bg-emerald-400"}`}
                              style={{ width: `${Math.min(cpuNum, 100)}%` }} />
                          </div>
                        </div>
                        {/* RAM */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-[var(--muted)] flex items-center gap-1"><MemoryStick size={12} /> {t("dashboardMemory")}</span>
                            <span className={`text-sm font-semibold ${memNum > 85 ? "text-red-400" : memNum > 60 ? "text-amber-400" : "text-emerald-400"}`}>
                              {qm?.memory_percent || "—"}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-[var(--background)] rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${memNum > 85 ? "bg-red-400" : memNum > 60 ? "bg-amber-400" : "bg-emerald-400"}`}
                              style={{ width: `${Math.min(memNum, 100)}%` }} />
                          </div>
                          <p className="text-[10px] text-[var(--muted)] mt-1">{qm?.memory || ""}</p>
                        </div>
                        {/* Response Time */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-[var(--muted)] flex items-center gap-1"><Timer size={12} /> {t("dashboardResponse")}</span>
                            <span className={`text-sm font-semibold ${!rtMs ? "text-[var(--muted)]" : rtMs > 2000 ? "text-red-400" : rtMs > 500 ? "text-amber-400" : "text-emerald-400"}`}>
                              {rtMs != null ? `${rtMs}ms` : "—"}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-[var(--background)] rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${!rtMs ? "bg-gray-600" : rtMs > 2000 ? "bg-red-400" : rtMs > 500 ? "bg-amber-400" : "bg-emerald-400"}`}
                              style={{ width: `${rtMs ? Math.min((rtMs / 3000) * 100, 100) : 0}%` }} />
                          </div>
                        </div>
                        {/* Workers */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-[var(--muted)] flex items-center gap-1"><Layers size={12} /> {t("dashboardWorkers")}</span>
                            <span className="text-sm font-semibold text-[var(--accent)]">{instance.workers}</span>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-[var(--muted)] mt-1">
                            <span><Cpu size={10} className="inline" /> {t("dashboardCores", { count: instance.cpu_cores })}</span>
                            <span><MemoryStick size={10} className="inline" /> {instance.ram_mb >= 1024 ? `${(instance.ram_mb / 1024).toFixed(1)}GB` : `${instance.ram_mb}MB`}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="grid gap-4 md:grid-cols-2">
                      {/* Access & Credentials */}
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Globe size={14} /> {t("accessCredentials")}</h3>
                        <div className="space-y-3">
                          {instance.domain && (
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-[var(--muted)]">{t("accessDomain")}</span>
                              <a href={instance.url || `https://${instance.domain}`} target="_blank" rel="noopener"
                                className="text-sm text-[var(--accent)] hover:underline flex items-center gap-1 truncate max-w-[200px]">
                                {instance.domain} <ExternalLink size={10} />
                              </a>
                            </div>
                          )}
                          {server && (
                            <div className="flex items-center justify-between">
                              <span className="text-sm text-[var(--muted)]">{t("accessServer")}</span>
                              <a href={`/servers/${server.id}`} className="text-xs font-mono text-[var(--accent)] hover:underline cursor-pointer">{server.name} <span className="text-white/40">({server.endpoint})</span></a>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("accessAdminPassword")}</span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-mono">{showPassword ? (instance.config?.admin_password || "admin") : "••••••••"}</span>
                              <button onClick={() => setShowPassword(!showPassword)} className="p-1 text-[var(--muted)] hover:text-white rounded" title={showPassword ? t("accessHide") : t("accessShow")}>
                                {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                              </button>
                              <button onClick={handleCopyPassword} className="p-1 text-[var(--muted)] hover:text-white rounded" title={t("accessCopy")}>
                                {passwordCopied ? <CheckCircle size={12} className="text-[var(--success)]" /> : <Copy size={12} />}
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("accessDatabase")}</span>
                            <span className="text-sm font-mono">{instance.config?.db_name || instance.name}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("accessPort")}</span>
                            <span className="text-sm font-mono">{instance.config?.port || 8069}</span>
                          </div>
                        </div>
                      </div>

                      {/* Quick Stats & Info */}
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Activity size={14} /> {t("overview")}</h3>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("overviewCreated")}</span>
                            <span className="text-sm">{instance.created_at ? new Date(instance.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" }) : "N/A"}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("overviewBackups")}</span>
                            <span className="text-sm">{backups.length} <span className="text-[var(--muted)]">({lastBackup.date})</span></span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("overviewSsl")}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${instance.config?.auto_ssl !== false ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                              {instance.config?.auto_ssl !== false ? t("overviewSslActive") : t("overviewSslDisabled")}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("overviewEnterprise")}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${instance.config?.enterprise ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-white/5 text-[var(--muted)]"}`}>
                              {instance.config?.enterprise ? t("overviewEnterpriseEnabled") : t("overviewEnterpriseCommunity")}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-[var(--muted)]">{t("overviewAutoUpdate")}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${instance.config?.auto_update ? "bg-emerald-500/10 text-emerald-400" : "bg-white/5 text-[var(--muted)]"}`}>
                              {instance.config?.auto_update ? t("overviewAutoUpdateOn") : t("overviewAutoUpdateOff")}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Recent Activity */}
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><History size={14} /> {t("recentActivity")}</h3>
                        {(instance.config?.config_changelog?.length > 0 || backups.length > 0) ? (
                          <div className="space-y-2 max-h-48 overflow-y-auto">
                            {/* Config changes */}
                            {(instance.config?.config_changelog || []).slice(-5).reverse().map((entry: any, i: number) => (
                              <div key={`cfg-${i}`} className="flex items-center gap-3 text-xs py-1.5 border-b border-white/[0.03] last:border-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                                <span className="text-[var(--muted)]">{new Date(entry.timestamp).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                                <span className="text-white">{t("configUpdated")} <span className="font-mono text-amber-300">{entry.params?.join(", ")}</span></span>
                              </div>
                            ))}
                            {/* Recent backups */}
                            {backups.slice(0, 3).map((bk: any, i: number) => (
                              <div key={`bk-${i}`} className="flex items-center gap-3 text-xs py-1.5 border-b border-white/[0.03] last:border-0">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${bk.status === "completed" ? "bg-emerald-400" : "bg-[var(--muted)]"}`} />
                                <span className="text-[var(--muted)]">{bk.created_at ? new Date(bk.created_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                                <span className="text-white">{t("backupLabel")} <span className={bk.status === "completed" ? "text-emerald-400" : "text-[var(--muted)]"}>{bk.status}</span></span>
                                {bk.size && <span className="text-[var(--muted)] ml-auto">{bk.size}</span>}
                              </div>
                            ))}
                            {(instance.config?.config_changelog?.length === 0 && backups.length === 0) && (
                              <p className="text-xs text-[var(--muted)] text-center py-4">{t("recentActivityNone")}</p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-[var(--muted)] text-center py-4">{t("recentActivityNone")}</p>
                        )}
                      </div>

                      {/* Quick Actions */}
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Zap size={14} /> {t("quickActions")}</h3>
                        <div className="flex flex-wrap gap-2">
                          {instance.domain && (
                            <a href={instance.url || `https://${instance.domain}`} target="_blank" rel="noopener"
                              className="px-3 py-2 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors flex items-center gap-1.5">
                              <ExternalLink size={12} /> {t("dashboardOpenOdoo")}
                            </a>
                          )}
                          {instance.domain && (
                            <a href={`${instance.url || `https://${instance.domain}`}/web/database/manager`} target="_blank" rel="noopener"
                              className="px-3 py-2 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5">
                              <Database size={12} /> {t("quickActionsDbManager")}
                            </a>
                          )}
                          <button onClick={handleCreateBackup} disabled={!!actionLoading || !isOnline}
                            className="px-3 py-2 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                            {actionLoading === "backup" ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />} {t("quickActionsBackupNow")}
                          </button>
                          <button onClick={() => setActiveTab("logs")}
                            className="px-3 py-2 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5">
                            <ScrollText size={12} /> {t("quickActionsLogs")}
                          </button>
                          <button onClick={() => setActiveTab("monitoring")}
                            className="px-3 py-2 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5">
                            <Activity size={12} /> {t("quickActionsMonitoring")}
                          </button>
                          <button onClick={() => setActiveTab("config")}
                            className="px-3 py-2 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5">
                            <Settings2 size={12} /> {t("quickActionsConfig")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ========== LOGS TAB ========== */}
              {activeTab === "logs" && (
                <div className="relative">
                  <LogViewer instanceId={instanceId} active={activeTab === "logs"} />
                </div>
              )}

              {/* ========== DATABASE TAB ========== */}
              {activeTab === "database" && (
                <DatabaseExplorer instanceId={instanceId} />
              )}

              {/* ========== BACKUPS TAB ========== */}
              {activeTab === "backups" && (() => {
                const completedBackups = backups.filter(b => b.status === "completed");
                const failedBackups = backups.filter(b => b.status === "failed");
                const totalSizeMb = completedBackups.reduce((sum, b) => sum + (b.size_mb || 0), 0);
                const pendingBackups = backups.filter(b => b.status === "pending" || b.status === "in_progress");

                const formatSize = (mb: number) => {
                  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
                  return `${mb} MB`;
                };

                const formatDate = (iso: string) => new Date(iso).toLocaleString("it-IT", {
                  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
                });

                const formatDuration = (start: string, end: string | null) => {
                  if (!end) return "-";
                  const ms = new Date(end).getTime() - new Date(start).getTime();
                  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
                  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
                };

                const handleDeleteBackup = async (backupId: string) => {
                  if (!confirm(t("backupConfirmDelete"))) return;
                  setActionLoading(`delete-bkp-${backupId}`);
                  try {
                    await backupsApi.remove(backupId);
                    setBackups(prev => prev.filter(b => b.id !== backupId));
                  } catch (err: any) { alert(err.message); }
                  finally { setActionLoading(null); }
                };

                return (
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Database size={15} /> {t("backupManagement")}</h3>
                      <button
                        onClick={handleCreateBackup}
                        disabled={!!actionLoading || instance.status !== "running"}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2 disabled:opacity-50"
                      >
                        {actionLoading === "backup" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t("backupNew")}
                      </button>
                    </div>

                    {/* Stats Cards */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                        <div className="text-xs text-[var(--muted)] mb-1">{t("backupTotalBackups")}</div>
                        <div className="text-xl font-bold">{backups.length}</div>
                      </div>
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                        <div className="text-xs text-[var(--muted)] mb-1 flex items-center gap-1"><CheckCircle size={11} className="text-emerald-400" /> {t("backupCompleted")}</div>
                        <div className="text-xl font-bold text-emerald-400">{completedBackups.length}</div>
                      </div>
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                        <div className="text-xs text-[var(--muted)] mb-1 flex items-center gap-1"><XCircle size={11} className="text-red-400" /> {t("backupFailed")}</div>
                        <div className="text-xl font-bold text-red-400">{failedBackups.length}</div>
                      </div>
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                        <div className="text-xs text-[var(--muted)] mb-1 flex items-center gap-1"><HardDrive size={11} /> {t("backupTotalSize")}</div>
                        <div className="text-xl font-bold">{formatSize(totalSizeMb)}</div>
                      </div>
                    </div>

                    {/* Schedule Configuration */}
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-sm font-semibold flex items-center gap-2"><Calendar size={14} /> {t("backupSchedule")}</h4>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${backupSchedule.enabled ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-500/10 text-zinc-400"}`}>
                            {backupSchedule.enabled ? t("backupScheduleActive") : t("backupScheduleDisabled")}
                          </span>
                          <button
                            onClick={() => setBackupSchedule(s => ({ ...s, enabled: !s.enabled }))}
                            className={`relative w-10 h-5 rounded-full transition-colors ${backupSchedule.enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${backupSchedule.enabled ? "translate-x-5" : ""}`} />
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-4 md:grid-cols-3">
                        <div>
                          <label className="text-xs text-[var(--muted)] mb-1.5 block">{t("backupFrequency")}</label>
                          <select
                            value={backupSchedule.frequency}
                            onChange={(e) => setBackupSchedule(s => ({ ...s, frequency: e.target.value }))}
                            disabled={!backupSchedule.enabled}
                            className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 disabled:opacity-50"
                          >
                            <option value="every_6h">{t("backupFreqEvery6h")}</option>
                            <option value="every_12h">{t("backupFreqEvery12h")}</option>
                            <option value="daily">{t("backupFreqDaily")}</option>
                            <option value="weekly">{t("backupFreqWeekly")}</option>
                            <option value="monthly">{t("backupFreqMonthly")}</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-[var(--muted)] mb-1.5 block">{t("backupRetentionPeriod")}</label>
                          <select
                            value={backupSchedule.retention_days}
                            onChange={(e) => setBackupSchedule(s => ({ ...s, retention_days: parseInt(e.target.value) }))}
                            disabled={!backupSchedule.enabled}
                            className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 disabled:opacity-50"
                          >
                            <option value={7}>{t("backupRetention7d")}</option>
                            <option value={14}>{t("backupRetention14d")}</option>
                            <option value={30}>{t("backupRetention30d")}</option>
                            <option value={60}>{t("backupRetention60d")}</option>
                            <option value={90}>{t("backupRetention90d")}</option>
                            <option value={180}>{t("backupRetention180d")}</option>
                            <option value={365}>{t("backupRetention1y")}</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-xs text-[var(--muted)] mb-1.5 block">{t("backupLastBackup")}</label>
                          <div className="text-sm py-2 flex items-center gap-2">
                            {lastBackup.date === "Never" || lastBackup.date === t("never") ? (
                              <span className="text-[var(--muted)]">{t("backupNoBackupsYet")}</span>
                            ) : (
                              <>
                                <Clock size={13} className="text-[var(--muted)]" />
                                <span>{lastBackup.date}</span>
                                {lastBackup.status && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded capitalize ${
                                    lastBackup.status === "completed" ? "bg-emerald-500/10 text-emerald-400" :
                                    lastBackup.status === "failed" ? "bg-red-500/10 text-red-400" :
                                    "bg-amber-500/10 text-amber-400"
                                  }`}>{lastBackup.status}</span>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* In-Progress Backups */}
                    {pendingBackups.length > 0 && (
                      <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Loader2 size={14} className="animate-spin text-blue-400" />
                          <span className="text-sm font-medium text-blue-400">{t("backupInProgress")}</span>
                        </div>
                        {pendingBackups.map(bkp => (
                          <div key={bkp.id} className="flex items-center justify-between text-sm">
                            <span className="text-[var(--muted)] font-mono text-xs">{bkp.id.slice(0, 8)}...</span>
                            <span className="text-xs capitalize text-blue-400">{bkp.status}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Backup History */}
                    {backups.length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Database size={40} className="mx-auto text-[var(--muted)] mb-4" />
                        <h4 className="text-base font-semibold mb-2">{t("backupNoBackupsTitle")}</h4>
                        <p className="text-sm text-[var(--muted)] max-w-md mx-auto mb-4">
                          {t("backupNoBackupsDesc")}
                        </p>
                        <button
                          onClick={handleCreateBackup}
                          disabled={!!actionLoading || instance.status !== "running"}
                          className="px-4 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors inline-flex items-center gap-2 disabled:opacity-50"
                        >
                          <Plus size={14} /> {t("backupCreateFirst")}
                        </button>
                      </div>
                    ) : (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
                          <h4 className="text-sm font-semibold">{t("backupHistory")}</h4>
                          <span className="text-xs text-[var(--muted)]">{t("backupCount", { count: backups.length })}</span>
                        </div>
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                              <th className="text-left px-4 py-2.5">{t("backupTableStatus")}</th>
                              <th className="text-left px-4 py-2.5">{t("backupTableType")}</th>
                              <th className="text-left px-4 py-2.5">{t("backupTableSize")}</th>
                              <th className="text-left px-4 py-2.5">{t("backupTableCreated")}</th>
                              <th className="text-left px-4 py-2.5">{t("backupTableDuration")}</th>
                              <th className="text-right px-4 py-2.5">{t("backupTableActions")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {backups.map((bkp) => (
                              <tr key={bkp.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)] transition-colors">
                                <td className="px-4 py-3">
                                  {bkp.status === "in_progress" && bkp.progress?.step ? (() => {
                                    const steps = ["preparing", "db_dump", "filestore", "finalizing"];
                                    const labels: Record<string, string> = { preparing: t("backupStepPreparing"), db_dump: t("backupStepDbDump"), filestore: t("backupStepFilestore"), finalizing: t("backupStepFinalizing") };
                                    const currentIdx = steps.indexOf(bkp.progress.step);
                                    const pct = currentIdx >= 0 ? Math.round(((currentIdx + 0.5) / steps.length) * 100) : 10;
                                    return (
                                      <div className="space-y-1.5">
                                        <div className="flex items-center gap-2 text-sm">
                                          <Loader2 size={14} className="text-blue-400 animate-spin" />
                                          <span className="text-blue-400 font-medium">{labels[bkp.progress.step] || bkp.progress.step}</span>
                                        </div>
                                        <div className="w-full bg-[var(--border)] rounded-full h-1.5 overflow-hidden">
                                          <div className="bg-blue-500 h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${pct}%` }} />
                                        </div>
                                        <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
                                          {steps.map((s, i) => (
                                            <span key={s} className={i <= currentIdx ? "text-blue-400" : ""}>{labels[s]}</span>
                                          ))}
                                        </div>
                                      </div>
                                    );
                                  })() : (
                                    <div className="flex items-center gap-2 text-sm">
                                      {bkp.status === "completed" && <CheckCircle size={14} className="text-emerald-400" />}
                                      {bkp.status === "failed" && <XCircle size={14} className="text-red-400" />}
                                      {bkp.status === "pending" && <Clock size={14} className="text-amber-400" />}
                                      {bkp.status === "in_progress" && <Loader2 size={14} className="text-blue-400 animate-spin" />}
                                      <span className="capitalize">{bkp.status}</span>
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                                    bkp.backup_type === "manual" ? "bg-blue-500/10 text-blue-400" :
                                    bkp.backup_type === "scheduled" ? "bg-emerald-500/10 text-emerald-400" :
                                    bkp.backup_type === "pre_update" ? "bg-amber-500/10 text-amber-400" :
                                    "bg-zinc-500/10 text-zinc-400"
                                  }`}>{bkp.backup_type?.replace("_", " ")}</span>
                                </td>
                                <td className="px-4 py-3 text-sm text-[var(--muted)]">
                                  {bkp.size_mb ? formatSize(bkp.size_mb) : "-"}
                                </td>
                                <td className="px-4 py-3 text-sm text-[var(--muted)]">
                                  {formatDate(bkp.created_at)}
                                </td>
                                <td className="px-4 py-3 text-sm text-[var(--muted)]">
                                  {bkp.duration_seconds ? `${bkp.duration_seconds < 60 ? bkp.duration_seconds + "s" : Math.floor(bkp.duration_seconds / 60) + "m " + (bkp.duration_seconds % 60) + "s"}` : formatDuration(bkp.created_at, bkp.completed_at)}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-1 justify-end">
                                    {bkp.status === "completed" && (
                                      <button
                                        onClick={() => handleRestore(bkp.id)}
                                        disabled={!!actionLoading}
                                        className="text-xs px-2.5 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center gap-1 disabled:opacity-50"
                                      >
                                        {actionLoading === `restore-${bkp.id}` ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} {t("backupRestore")}
                                      </button>
                                    )}
                                    {(bkp.status === "pending" || bkp.status === "in_progress") && (
                                      <button
                                        onClick={() => handleCancelBackup(bkp.id)}
                                        disabled={!!actionLoading}
                                        className="text-xs px-2.5 py-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1 disabled:opacity-50"
                                      >
                                        {actionLoading === `cancel-bkp-${bkp.id}` ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />} {t("backupCancel")}
                                      </button>
                                    )}
                                    {(bkp.status === "completed" || bkp.status === "failed") && (
                                      <button
                                        onClick={() => handleDeleteBackup(bkp.id)}
                                        disabled={!!actionLoading}
                                        className="text-xs p-1.5 rounded-md text-[var(--muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                        title={t("backupDeleteBackup")}
                                      >
                                        {actionLoading === `delete-bkp-${bkp.id}` ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Backup Info */}
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                      <h4 className="text-xs font-semibold text-[var(--muted)] mb-3 flex items-center gap-1.5"><Shield size={12} /> {t("backupContents")}</h4>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-[var(--muted)]">
                        <div className="flex items-start gap-2">
                          <Database size={13} className="text-blue-400 mt-0.5 shrink-0" />
                          <div><span className="text-[var(--foreground)] font-medium">{t("backupFullDatabase")}</span><br />{t("backupFullDatabaseDesc")}</div>
                        </div>
                        <div className="flex items-start gap-2">
                          <FolderOpen size={13} className="text-emerald-400 mt-0.5 shrink-0" />
                          <div><span className="text-[var(--foreground)] font-medium">{t("backupFilestore")}</span><br />{t("backupFilestoreDesc")}</div>
                        </div>
                        <div className="flex items-start gap-2">
                          <FileText size={13} className="text-amber-400 mt-0.5 shrink-0" />
                          <div><span className="text-[var(--foreground)] font-medium">{t("backupConfiguration")}</span><br />{t("backupConfigurationDesc")}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ========== CONFIG TAB ========== */}
              {activeTab === "config" && (() => {
                const sectionIcons: Record<string, typeof Database> = {
                  database: Database, performance: Gauge, network: Globe,
                  logging: ScrollText, email: Mail, developer: Code,
                  i18n: Languages, misc: Settings2, paths: FolderOpen,
                };

                const dirtyCount = Object.keys(odooConfigDirty).length;
                const mergedConfig = { ...odooConfig, ...odooConfigDirty };

                // Group params by section
                const groupedParams: Record<string, [string, any][]> = {};
                for (const [key, schema] of Object.entries(odooSchema)) {
                  const section = (schema as any).section || "misc";
                  if (!groupedParams[section]) groupedParams[section] = [];
                  // Apply search filter
                  if (odooSearchFilter) {
                    const q = odooSearchFilter.toLowerCase();
                    if (!key.toLowerCase().includes(q) && !(schema as any).description?.toLowerCase().includes(q)) continue;
                  }
                  groupedParams[section].push([key, schema]);
                }

                // Sort sections by order
                const sortedSections = Object.entries(odooSections)
                  .sort(([, a], [, b]) => ((a as any).order || 99) - ((b as any).order || 99));

                const handleOdooParamChange = (key: string, value: any) => {
                  setOdooConfigDirty(prev => ({ ...prev, [key]: value }));
                };

                const handleSaveOdooConfig = async () => {
                  if (dirtyCount === 0) return;
                  setOdooConfigSaving(true);
                  setOdooConfigError(null);
                  setOdooConfigSuccess(null);
                  try {
                    await instancesApi.updateOdooConfig(instanceId, odooConfigDirty);
                    setOdooConfigSuccess(t("configParamsUpdated", { count: dirtyCount }));
                    setOdooConfigDirty({});
                    // Reload after a short delay to let restart begin
                    setTimeout(() => { loadOdooConfig(); loadInstance(); }, 3000);
                  } catch (err: any) {
                    setOdooConfigError(err.message || t("configFailedSave"));
                  } finally {
                    setOdooConfigSaving(false);
                  }
                };

                const handleApplyPreset = async (presetName: string) => {
                  if (!confirm(t("configConfirmPreset", { name: odooPresets[presetName]?.label }))) return;
                  setOdooPresetApplying(presetName);
                  setOdooConfigError(null);
                  setOdooConfigSuccess(null);
                  try {
                    await instancesApi.applyConfigPreset(instanceId, presetName);
                    setOdooConfigSuccess(t("configPresetApplied", { name: odooPresets[presetName]?.label }));
                    setOdooConfigDirty({});
                    setTimeout(() => { loadOdooConfig(); loadInstance(); }, 3000);
                  } catch (err: any) {
                    setOdooConfigError(err.message || t("configFailedApplyPreset"));
                  } finally {
                    setOdooPresetApplying(null);
                  }
                };

                const renderParamInput = (key: string, schema: any) => {
                  const value = mergedConfig[key] ?? schema.default ?? "";
                  const isReadonly = odooReadonly.includes(key) || schema.readonly;
                  const isDirty = key in odooConfigDirty;
                  const isPassword = schema.type === "password";
                  const showPw = odooShowPasswords.has(key);

                  const baseClass = `w-full text-sm bg-[var(--background)] border rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--accent)] transition-colors ${
                    isDirty ? "border-amber-500/50 bg-amber-500/5" : "border-[var(--border)]"
                  } ${isReadonly ? "opacity-60 cursor-not-allowed" : ""}`;

                  if (schema.type === "boolean") {
                    return (
                      <button
                        onClick={() => !isReadonly && handleOdooParamChange(key, !value)}
                        disabled={isReadonly}
                        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                          value ? "bg-emerald-500" : "bg-gray-600"
                        } ${isReadonly ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${value ? "translate-x-5" : ""}`} />
                      </button>
                    );
                  }

                  if (schema.type === "select") {
                    return (
                      <select
                        value={String(value)}
                        onChange={(e) => handleOdooParamChange(key, e.target.value)}
                        disabled={isReadonly}
                        className={baseClass}
                      >
                        {(schema.options || []).map((opt: string) => (
                          <option key={opt} value={opt}>{opt || t("configEmpty")}</option>
                        ))}
                      </select>
                    );
                  }

                  if (isPassword) {
                    return (
                      <div className="relative">
                        <input
                          type={showPw ? "text" : "password"}
                          value={String(value)}
                          onChange={(e) => handleOdooParamChange(key, e.target.value)}
                          disabled={isReadonly}
                          className={baseClass + " pr-10"}
                        />
                        <button
                          onClick={() => {
                            const s = new Set(odooShowPasswords);
                            if (s.has(key)) s.delete(key); else s.add(key);
                            setOdooShowPasswords(s);
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white"
                        >
                          {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    );
                  }

                  if (schema.type === "number") {
                    return (
                      <input
                        type="number"
                        value={value === "" ? "" : Number(value)}
                        onChange={(e) => handleOdooParamChange(key, e.target.value === "" ? "" : Number(e.target.value))}
                        disabled={isReadonly}
                        className={baseClass}
                      />
                    );
                  }

                  // Default: text
                  return (
                    <input
                      type="text"
                      value={String(value)}
                      onChange={(e) => handleOdooParamChange(key, e.target.value)}
                      disabled={isReadonly}
                      className={baseClass}
                    />
                  );
                };

                return (
                  <div className="space-y-4">
                    {/* Header Bar — CloudPepper style */}
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div>
                          <h3 className="text-sm font-semibold flex items-center gap-2">
                            <FileText size={16} /> {t("configOdooTitle")}
                          </h3>
                          <p className="text-xs text-[var(--muted)] mt-0.5">
                            {t("configOdooDesc", { file: "odoo.conf" })}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {/* Show all toggle */}
                          <label className="flex items-center gap-2 cursor-pointer">
                            <button
                              onClick={() => { const next = !odooShowAll; setOdooShowAll(next); loadOdooConfig(next); }}
                              className={`relative w-10 h-5 rounded-full transition-colors ${odooShowAll ? "bg-[var(--accent)]" : "bg-gray-600"}`}
                            >
                              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${odooShowAll ? "translate-x-5" : ""}`} />
                            </button>
                            <span className="text-xs text-[var(--muted)]">{t("configShowAllOptions")}</span>
                          </label>
                          {/* Reload */}
                          <button
                            onClick={() => loadOdooConfig()}
                            disabled={odooConfigLoading}
                            className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors"
                            title={t("configReloadFromServer")}
                          >
                            <RotateCw size={14} className={odooConfigLoading ? "animate-spin" : ""} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Alerts */}
                    {odooConfigError && (
                      <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
                        <XCircle size={14} className="text-red-400 shrink-0" />
                        <span className="text-sm text-red-300">{odooConfigError}</span>
                        <button onClick={() => setOdooConfigError(null)} className="ml-auto text-red-400 hover:text-red-300"><X size={14} /></button>
                      </div>
                    )}
                    {odooConfigSuccess && (
                      <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                        <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                        <span className="text-sm text-emerald-300">{odooConfigSuccess}</span>
                        <button onClick={() => setOdooConfigSuccess(null)} className="ml-auto text-emerald-400 hover:text-emerald-300"><X size={14} /></button>
                      </div>
                    )}

                    {/* Presets Bar */}
                    {Object.keys(odooPresets).length > 0 && (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Sparkles size={14} className="text-[var(--accent)]" />
                          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">{t("configQuickPresets")}</span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {Object.entries(odooPresets).map(([key, preset]: [string, any]) => (
                            <button
                              key={key}
                              onClick={() => handleApplyPreset(key)}
                              disabled={odooPresetApplying !== null}
                              className="p-3 rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 transition-all text-left group"
                            >
                              {odooPresetApplying === key ? (
                                <Loader2 size={14} className="animate-spin text-[var(--accent)] mb-1" />
                              ) : (
                                <Zap size={14} className="text-[var(--muted)] group-hover:text-[var(--accent)] mb-1" />
                              )}
                              <div className="text-xs font-medium text-white">{preset.label}</div>
                              <div className="text-[10px] text-[var(--muted)] mt-0.5 leading-tight">{preset.description}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Search Bar */}
                    <div className="relative">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                      <input
                        type="text"
                        value={odooSearchFilter}
                        onChange={(e) => setOdooSearchFilter(e.target.value)}
                        placeholder={t("configSearchParameters")}
                        className="w-full text-sm bg-[var(--card)] border border-[var(--border)] rounded-xl pl-9 pr-9 py-2.5 focus:outline-none focus:border-[var(--accent)]"
                      />
                      {odooSearchFilter && (
                        <button onClick={() => setOdooSearchFilter("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white">
                          <X size={14} />
                        </button>
                      )}
                    </div>

                    {/* Loading */}
                    {odooConfigLoading && Object.keys(odooConfig).length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("configLoadingConfig")}</p>
                      </div>
                    ) : (
                      <>
                        {/* Config Sections — CloudPepper table style */}
                        {sortedSections.map(([sectionKey, sectionMeta]: [string, any]) => {
                          const params = groupedParams[sectionKey];
                          if (!params || params.length === 0) return null;
                          const isExpanded = odooExpandedSections.has(sectionKey) || !!odooSearchFilter;
                          const SectionIcon = sectionIcons[sectionKey] || Settings2;
                          const dirtyInSection = params.filter(([k]) => k in odooConfigDirty).length;

                          return (
                            <div key={sectionKey} className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                              {/* Section header */}
                              <button
                                onClick={() => {
                                  const s = new Set(odooExpandedSections);
                                  if (s.has(sectionKey)) s.delete(sectionKey); else s.add(sectionKey);
                                  setOdooExpandedSections(s);
                                }}
                                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
                              >
                                <div className="flex items-center gap-2">
                                  <SectionIcon size={15} className="text-[var(--accent)]" />
                                  <span className="text-sm font-semibold">{sectionMeta.label}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-[var(--muted)]">{params.length}</span>
                                  {dirtyInSection > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">{t("configChanged", { count: dirtyInSection })}</span>
                                  )}
                                </div>
                                {isExpanded ? <ChevronUp size={14} className="text-[var(--muted)]" /> : <ChevronDown size={14} className="text-[var(--muted)]" />}
                              </button>

                              {/* Params table */}
                              {isExpanded && (
                                <div className="border-t border-[var(--border)]">
                                  <table className="w-full text-sm">
                                    <thead>
                                      <tr className="text-left text-[10px] text-[var(--muted)] uppercase tracking-wider border-b border-[var(--border)]">
                                        <th className="px-4 py-2 w-1/3">{t("configParamName")}</th>
                                        <th className="px-4 py-2">{t("configParamValue")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {params.map(([key, schema]: [string, any]) => (
                                        <tr key={key} className={`border-b border-white/[0.03] last:border-0 ${key in odooConfigDirty ? "bg-amber-500/[0.03]" : ""}`}>
                                          <td className="px-4 py-2.5 align-top">
                                            <div className="flex items-center gap-1.5">
                                              <span className="font-mono text-xs font-medium text-white">{key}</span>
                                              {schema.readonly && <Lock size={10} className="text-[var(--muted)]" />}
                                              {key in odooConfigDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
                                            </div>
                                            <p className="text-[11px] text-[var(--muted)] mt-0.5 leading-tight max-w-xs">{schema.description}</p>
                                          </td>
                                          <td className="px-4 py-2.5">
                                            {renderParamInput(key, schema)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {/* Floating Save Bar */}
                        {dirtyCount > 0 && (
                          <div className="sticky bottom-4 z-10">
                            <div className="bg-[var(--card)] border border-amber-500/30 rounded-xl p-3 shadow-2xl flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                                <span className="text-sm text-amber-300 font-medium">{t("configUnsavedChanges", { count: dirtyCount })}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setOdooConfigDirty({})}
                                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-white transition-colors flex items-center gap-1"
                                >
                                  <Undo2 size={12} /> {t("configDiscard")}
                                </button>
                                <button
                                  onClick={handleSaveOdooConfig}
                                  disabled={odooConfigSaving}
                                  className="px-4 py-1.5 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                >
                                  {odooConfigSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} {t("configSaveRestart")}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {/* ========== ADDONS TAB ========== */}
              {activeTab === "addons" && (
                <div>
                  {/* Conflict & Compatibility Warnings */}
                  {conflicts?.conflicts?.length > 0 && (
                    <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle size={14} className="text-red-400 shrink-0" />
                        <span className="text-sm font-medium text-red-300">{t("addonsConflictsDetected")}</span>
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
                        <span className="text-sm font-medium text-amber-300">{t("addonsCompatibilityWarnings")}</span>
                      </div>
                      {compatibility.issues.map((c: any, i: number) => (
                        <p key={i} className="text-xs text-amber-400 ml-6">
                          Version mismatch: {c.module} (v{c.module_version}) is not compatible with Odoo {instance?.version}
                        </p>
                      ))}
                    </div>
                  )}

                  {/* GitHub Connection Banner */}
                  <div className={`mb-4 p-3 rounded-xl border flex items-center justify-between ${
                    githubConnected
                      ? "bg-[var(--card)] border-[var(--border)]"
                      : "bg-amber-500/5 border-amber-500/20"
                  }`}>
                    <div className="flex items-center gap-3">
                      <Github size={18} className={githubConnected ? "text-white" : "text-amber-400"} />
                      {githubConnected ? (
                        <div className="flex items-center gap-2">
                          {githubAvatar && <img src={githubAvatar} alt="" className="w-5 h-5 rounded-full" />}
                          <span className="text-sm text-white font-medium">{githubUsername}</span>
                          <span className="text-xs text-[var(--success)] flex items-center gap-1"><Link2 size={10} /> {t("addonsGithubConnected")}</span>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm text-amber-300 font-medium">{t("addonsGithubNotConnected")}</p>
                          <p className="text-xs text-[var(--muted)]">{t("addonsGithubNotConnectedDesc")}</p>
                        </div>
                      )}
                    </div>
                    {githubConnected ? (
                      <button
                        onClick={async () => {
                          if (!confirm(t("addonsConfirmDisconnectGithub"))) return;
                          try {
                            await githubApi.disconnect();
                            setGithubConnected(false);
                            setGithubUsername("");
                            setGithubAvatar("");
                          } catch {}
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-red-400 hover:border-red-400/30 transition-colors flex items-center gap-1"
                      >
                        <Unlink2 size={10} /> {t("addonsDisconnect")}
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          try {
                            const auth = await githubApi.authorize(`/instances/${instanceId}`);
                            window.location.href = auth.authorize_url;
                          } catch {
                            alert(t("addonsGithubOAuthNotConfigured"));
                          }
                        }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white transition-colors flex items-center gap-1"
                      >
                        <Github size={12} /> {t("addonsConnectGithub")}
                      </button>
                    )}
                  </div>

                  {/* Addons Table — Cloudpepper style */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 mb-4">
                    <h3 className="text-sm font-semibold mb-4">{t("addonsTitle")}</h3>

                    {addonsLoading ? (
                      <div className="text-center py-8">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-2" />
                        <p className="text-sm text-[var(--muted)]">{t("addonsLoading")}</p>
                      </div>
                    ) : addons.length === 0 ? (
                      <div className="text-center py-8">
                        <Puzzle size={32} className="mx-auto text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("addonsNone")}</p>
                        <p className="text-xs text-[var(--muted)] mt-1">
                          {t("addonsAddHint")}
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-[var(--muted)] uppercase tracking-wider border-b border-[var(--border)]">
                              <th className="pb-3 pr-4">{t("addonsThType")}</th>
                              <th className="pb-3 pr-4">{t("addonsThRepoName")}</th>
                              <th className="pb-3 pr-4">{t("addonsThBranch")}</th>
                              <th className="pb-3 pr-4">{t("addonsThRevision")}</th>
                              <th className="pb-3 pr-4">{t("addonsThStatus")}</th>
                              <th className="pb-3 text-right">{t("addonsThActions")}</th>
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
                                        : addon.type === "marketplace"
                                        ? "bg-emerald-500/10 text-emerald-400"
                                        : "bg-[var(--accent)]/10 text-[var(--accent)]"
                                    }`}>
                                      {addon.type === "git" ? (
                                        <span className="flex items-center gap-1"><GitBranch size={10} /> {t("addonsTypeGit")}</span>
                                      ) : addon.type === "marketplace" ? (
                                        <span className="flex items-center gap-1"><Store size={10} /> {t("addonsTypeModule")}</span>
                                      ) : (
                                        <span className="flex items-center gap-1"><Package size={10} /> {t("addonsTypeFile")}</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="py-3 pr-4">
                                    {addon.type === "marketplace" ? (
                                      <div className="flex items-center gap-2">
                                        <span className="font-medium text-white">{addon.display_name || addon.name}</span>
                                        <span className="text-xs text-[var(--muted)] font-mono">{addon.name}</span>
                                        {addon.repo_name && (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                                            {addon.repo_name}
                                          </span>
                                        )}
                                      </div>
                                    ) : addon.type === "git" && addon.url ? (
                                      <div className="flex items-center gap-2">
                                        {addon.has_token && (
                                          <span title={t("addonsPrivateRepo")}>
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
                                          title={t("addonsOpenRepo")}
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
                                      {(addon.type === "git" || addon.type === "marketplace") && addon.current_commit ? (
                                        <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-mono flex items-center gap-1" title={addon.current_commit}>
                                          <GitCommit size={10} />
                                          {addon.current_commit?.substring(0, 7)}
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
                                            title={t("addonsExploreModules")}
                                          >
                                            <Eye size={13} />
                                          </button>
                                          <button
                                            onClick={() => setShowAddonSettingsModal(addon)}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors"
                                            title={t("addonsRepoSettings")}
                                          >
                                            <Settings2 size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              try {
                                                const result = await instancesApi.updateGitAddon(instanceId, addon.id);
                                                setShowUpdateModal({ addon, result });
                                              } catch (e: any) {
                                                alert(e.message || t("addonsFailedCheckUpdates"));
                                              }
                                            }}
                                            disabled={instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors disabled:opacity-50"
                                            title={t("addonsUpdate")}
                                          >
                                            <RefreshCw size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              if (!confirm(t("addonsConfirmRemoveGit", { name: addon.name || addon.url }))) return;
                                              setGitAddonRemoving(addon.id);
                                              try {
                                                await instancesApi.removeGitAddon(instanceId, addon.id);
                                                loadAddons();
                                              } catch (e: any) {
                                                alert(e.message || t("addonsFailedRemove"));
                                              } finally {
                                                setGitAddonRemoving(null);
                                              }
                                            }}
                                            disabled={gitAddonRemoving === addon.id || instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                            title={t("addonsRemove")}
                                          >
                                            {gitAddonRemoving === addon.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                                          </button>
                                        </>
                                      )}

                                      {/* Marketplace module actions */}
                                      {addon.type === "marketplace" && (
                                        <>
                                          <button
                                            onClick={() => setShowAddonSettingsModal(addon)}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors"
                                            title={t("addonsModuleSettings")}
                                          >
                                            <Settings2 size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              try {
                                                const result = await instancesApi.updateGitAddon(instanceId, addon.id);
                                                setShowUpdateModal({ addon, result });
                                              } catch (e: any) {
                                                alert(e.message || t("addonsFailedCheckUpdates"));
                                              }
                                            }}
                                            disabled={!addon.can_update || instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors disabled:opacity-50"
                                            title={t("addonsUpdateModule")}
                                          >
                                            <RefreshCw size={13} />
                                          </button>
                                          <button
                                            onClick={async () => {
                                              if (!confirm(t("addonsConfirmUninstallModule", { name: addon.display_name || addon.name }))) return;
                                              setGitAddonRemoving(addon.id);
                                              try {
                                                await instancesApi.uninstallMarketplaceModule(instanceId, addon.id);
                                                loadAddons();
                                              } catch (e: any) {
                                                alert(e.message || t("addonsFailedRemoveModule"));
                                              } finally {
                                                setGitAddonRemoving(null);
                                              }
                                            }}
                                            disabled={gitAddonRemoving === addon.id || instance?.status !== "running"}
                                            className="p-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                            title={t("addonsUninstall")}
                                          >
                                            {gitAddonRemoving === addon.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                                          </button>
                                        </>
                                      )}

                                      {/* Enterprise / File addon actions */}
                                      {addon.type === "file" && (
                                        <>
                                          {addon.can_update && (
                                            <button
                                              onClick={async () => {
                                                if (!confirm(t("addonsUpdateEnterprise"))) return;
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
                                                  alert(e.message || t("addonsFailedUpdate"));
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
                                              {addon.update_available ? t("addonsUpdateAvailable") : t("addonsUpdate")}
                                            </button>
                                          )}
                                          {addon.can_delete && (
                                            <button
                                              onClick={async () => {
                                                if (!confirm(t("addonsConfirmRemoveEnterprise"))) return;
                                                try {
                                                  await instancesApi.removeEnterpriseAddons(instanceId);
                                                  loadAddons();
                                                  loadInstance();
                                                } catch (e: any) {
                                                  alert(e.message || t("addonsFailedRemove"));
                                                }
                                              }}
                                              disabled={instance?.status !== "running"}
                                              className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                            >
                                              {t("addonsDeleteLabel")}
                                            </button>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>

                                {/* Error Detail Row */}
                                {addon.status === "error" && addon.error && (
                                  <tr>
                                    <td colSpan={6} className="p-0">
                                      <div className="bg-red-500/5 border-t border-red-500/10 px-4 py-2.5 flex items-start gap-2">
                                        <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                          <span className="text-xs font-medium text-red-400">{t("addonsError")} </span>
                                          <span className="text-xs text-red-300/80 break-all">{addon.error}</span>
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                )}

                                {/* Module Explorer Panel — inline expansion */}
                                {showModulesPanel?.id === addon.id && addon.type === "git" && (
                                  <tr>
                                    <td colSpan={6} className="p-0">
                                      <div className="bg-[var(--background)] border-t border-[var(--border)] p-4">
                                        <div className="flex items-center justify-between mb-3">
                                          <h4 className="text-sm font-medium text-white flex items-center gap-2">
                                            <BookOpen size={14} />
                                            {t("addonsModulesIn", { name: addon.name || t("addonsRepository") })}
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
                                          <p className="text-xs text-[var(--muted)] py-2">{t("addonsNoModulesFound")}</p>
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
                                                      }`} title={versionMatch ? t("addonsCompatible") : t("addonsVersionMismatch")}>
                                                        {versionMatch ? <CheckCircle size={10} className="inline mr-0.5" /> : <AlertTriangle size={10} className="inline mr-0.5" />}
                                                        {mod.version}
                                                      </span>
                                                    )}
                                                    {mod.installable === false && (
                                                      <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">{t("addonsNotInstallable")}</span>
                                                    )}
                                                    {mod.dependencies?.length > 0 && (
                                                      <span className="text-[var(--muted)]" title={`Dependencies: ${mod.dependencies.join(", ")}`}>
                                                        {mod.dependencies.length} {t("addonsDeps")}
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
                          <p className="text-sm text-blue-300 font-medium">{t("addonsUpdateInProgress")}</p>
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
                        <Plus size={14} /> {t("addonsAddGitRepo")}
                      </button>
                      <button
                        onClick={async () => {
                          if (!githubConnected) {
                            // Load github status first
                            try {
                              const data = await githubApi.status();
                              if (!data.connected) {
                                // Redirect to OAuth
                                try {
                                  const auth = await githubApi.authorize(`/instances/${instanceId}`);
                                  window.location.href = auth.authorize_url;
                                } catch {
                                  alert(t("addonsGithubOAuthNotConfigured"));
                                }
                                return;
                              }
                              setGithubConnected(true);
                              setGithubUsername(data.username || "");
                            } catch {
                              try {
                                const auth = await githubApi.authorize(`/instances/${instanceId}`);
                                window.location.href = auth.authorize_url;
                              } catch {
                                alert(t("addonsGithubOAuthNotConfigured"));
                              }
                              return;
                            }
                          }
                          // Open repo browser
                          setShowGithubReposModal(true);
                          setGhRepos([]);
                          setGhSelectedRepo(null);
                          setGhRepoSearch("");
                          setGhReposLoading(true);
                          try {
                            const data = await githubApi.repos({ per_page: 30 });
                            setGhRepos(data.repos || []);
                          } catch { setGhRepos([]); }
                          finally { setGhReposLoading(false); }
                        }}
                        className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-2"
                      >
                        <Github size={14} /> {t("addonsAddFromGithub")}
                      </button>
                      <button
                        onClick={() => {
                          if (!githubConnected) {
                            alert(t("addonsConnectGithubFirst"));
                            return;
                          }
                          // Pre-fill with instance name
                          const name = instance?.name?.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-") || "crx-addons";
                          setGhUploadRepoName(`${name}-addons`);
                          setGhUploadRepoDesc(`Repository managed by CRX Cloud to store instance addons`);
                          setShowUploadGithubModal(true);
                        }}
                        className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-2"
                      >
                        <Upload size={14} /> {t("addonsUploadToGithub")}
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
                        <AlertTriangle size={12} /> {t("addonsCheckConflicts")}
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
                        <CheckCircle size={12} /> {t("addonsCheckCompatibility")}
                      </button>
                    </div>
                  </div>

                </div>
              )}

              {/* ========== MARKETPLACE TAB ========== */}
              {activeTab === "marketplace" && (
                <div>
                  {/* Search + Source + Category Filter */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 mb-4">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="relative flex-1">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                        <input
                          type="text"
                          value={mpSearch}
                          onChange={(e) => {
                            const val = e.target.value;
                            setMpSearch(val);
                            if (mpSearchDebounce) clearTimeout(mpSearchDebounce);
                            setMpSearchDebounce(setTimeout(() => {
                              setMpPage(1);
                              loadMarketplace(val, mpCategory, 1, mpSource);
                            }, 400));
                          }}
                          placeholder={t("mpSearchPlaceholder")}
                          className="w-full text-sm bg-[var(--background)] border border-[var(--border)] rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:border-[var(--accent)]"
                        />
                        {mpSearch && (
                          <button
                            onClick={() => { setMpSearch(""); setMpPage(1); loadMarketplace("", mpCategory, 1, mpSource); }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-white"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                      <span className="text-xs text-[var(--muted)] whitespace-nowrap">{t("mpModulesCount", { count: mpTotal })}</span>
                      <button
                        onClick={async () => {
                          setMpBuilding(true);
                          try {
                            await instancesApi.rebuildMarketplace(instanceId);
                            // Poll until done
                            setTimeout(() => loadMarketplace(), 10000);
                          } catch {}
                        }}
                        disabled={mpBuilding}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-white/20 transition-colors disabled:opacity-50 flex items-center gap-1"
                        title={t("mpRebuildTitle")}
                      >
                        <RefreshCw size={12} className={mpBuilding ? "animate-spin" : ""} /> {t("mpRebuild")}
                      </button>
                    </div>

                    {/* Source Tabs */}
                    {mpSources.length > 1 && (
                      <div className="flex gap-1 mb-3 p-1 bg-black/20 rounded-lg w-fit">
                        <button
                          onClick={() => { setMpSource(""); setMpPage(1); loadMarketplace(mpSearch, mpCategory, 1, ""); }}
                          className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                            !mpSource
                              ? "bg-[var(--accent)] text-white shadow-sm"
                              : "text-[var(--muted)] hover:text-white"
                          }`}
                        >
                          All Sources
                        </button>
                        {mpSources.map(src => (
                          <button
                            key={src}
                            onClick={() => { setMpSource(src); setMpPage(1); loadMarketplace(mpSearch, mpCategory, 1, src); }}
                            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                              mpSource === src
                                ? "bg-[var(--accent)] text-white shadow-sm"
                                : "text-[var(--muted)] hover:text-white"
                            }`}
                          >
                            {src}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Category Pills */}
                    <div className="flex flex-wrap gap-2 mb-4">
                      <button
                        onClick={() => { setMpCategory(""); setMpPage(1); loadMarketplace(mpSearch, "", 1, mpSource); }}
                        className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                          !mpCategory
                            ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                            : "border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-white/20"
                        }`}
                      >
                        All
                      </button>
                      {mpCategories.map(cat => (
                        <button
                          key={cat}
                          onClick={() => { setMpCategory(cat); setMpPage(1); loadMarketplace(mpSearch, cat, 1, mpSource); }}
                          className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                            mpCategory === cat
                              ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                              : "border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-white/20"
                          }`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>

                    {/* Module Cards Grid */}
                    {mpBuilding ? (
                      <div className="text-center py-16">
                        <Loader2 size={28} className="mx-auto animate-spin text-[var(--accent)] mb-3" />
                        <p className="text-sm text-white font-medium">{t("mpBuildingTitle")}</p>
                        <p className="text-xs text-[var(--muted)] mt-1">{t("mpBuildingDesc")}</p>
                        <p className="text-xs text-[var(--muted)] mt-1">{t("mpBuildingTime")}</p>
                        <div className="mt-4 w-48 mx-auto h-1 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-[var(--accent)] rounded-full animate-pulse" style={{ width: "60%" }} />
                        </div>
                      </div>
                    ) : mpLoading ? (
                      <div className="text-center py-16">
                        <Loader2 size={28} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("mpLoadingMarketplace")}</p>
                      </div>
                    ) : mpModules.length === 0 ? (
                      <div className="text-center py-16">
                        <Store size={36} className="mx-auto text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">
                          {mpSearch || mpCategory ? t("mpNoModulesMatch") : t("mpNoModulesAvailable")}
                        </p>
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                        {mpModules.map((mod: any) => (
                          <div
                            key={`${mod.repo_name}/${mod.technical_name}`}
                            className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-4 hover:border-[var(--accent)]/30 transition-colors group"
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-semibold text-white truncate" title={mod.display_name}>
                                  {mod.display_name}
                                </h4>
                                <p className="text-xs font-mono text-[var(--muted)] mt-0.5">{mod.technical_name}</p>
                              </div>
                              {mod.icon_url && (
                                <img
                                  src={mod.icon_url}
                                  alt=""
                                  className="w-8 h-8 rounded-lg ml-2 shrink-0 bg-white/5"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                />
                              )}
                            </div>

                            {mod.summary && (
                              <p className="text-xs text-[var(--muted)] mb-3 line-clamp-2">{mod.summary}</p>
                            )}

                            {/* Metadata */}
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {mod.version && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">
                                  v{mod.version}
                                </span>
                              )}
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                                {mod.repo_name}
                              </span>
                              {mod.source && (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                  mod.source === "OCA" ? "bg-blue-500/10 text-blue-400" :
                                  mod.source === "Cybrosys" ? "bg-orange-500/10 text-orange-400" :
                                  mod.source === "Odoo Mates" ? "bg-teal-500/10 text-teal-400" :
                                  "bg-white/5 text-[var(--muted)]"
                                }`}>
                                  {mod.source}
                                </span>
                              )}
                              {mod.license && mod.license !== "LGPL-3" && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[var(--muted)]">
                                  {mod.license}
                                </span>
                              )}
                            </div>

                            {/* Author + category */}
                            <div className="flex items-center justify-between text-[10px] text-[var(--muted)] mb-3">
                              <span className="truncate">{mod.author}</span>
                              <span className="px-1.5 py-0.5 rounded bg-white/5 shrink-0">{mod.repo_category}</span>
                            </div>

                            {/* Dependencies preview */}
                            {mod.depends?.length > 0 && (
                              <div className="text-[10px] text-[var(--muted)] mb-3 truncate" title={`Depends: ${mod.depends.join(", ")}`}>
                                {t("mpDeps")} {mod.depends.slice(0, 4).join(", ")}{mod.depends.length > 4 ? ` +${mod.depends.length - 4}` : ""}
                              </div>
                            )}

                            {/* Install button */}
                            {mod.installed ? (
                              <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-lg bg-[var(--success)]/10 text-[var(--success)] border border-[var(--success)]/20">
                                <CheckCircle size={12} /> {t("mpInstalled")}
                              </div>
                            ) : (
                              <button
                                onClick={async () => {
                                  if (instance?.status !== "running") {
                                    alert(t("mpInstanceMustBeRunning"));
                                    return;
                                  }
                                  setMpInstalling(mod.technical_name);
                                  try {
                                    await instancesApi.installMarketplaceModule(instanceId, {
                                      repo_url: mod.repo_url,
                                      module_name: mod.technical_name,
                                      branch: instance?.version,
                                    });
                                    // Mark as installed locally and reload
                                    setMpModules(prev => prev.map(m =>
                                      m.technical_name === mod.technical_name ? { ...m, installed: true } : m
                                    ));
                                    await loadInstance();
                                    loadAddons();
                                  } catch (e: any) {
                                    alert(e.message || t("mpInstallationFailed"));
                                  } finally {
                                    setMpInstalling(null);
                                  }
                                }}
                                disabled={mpInstalling === mod.technical_name || instance?.status !== "running"}
                                className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
                              >
                                {mpInstalling === mod.technical_name ? (
                                  <><Loader2 size={12} className="animate-spin" /> {t("mpInstalling")}</>
                                ) : (
                                  <><Download size={12} /> {t("mpInstall")}</>
                                )}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Pagination */}
                    {mpTotalPages > 1 && (
                      <div className="flex items-center justify-center gap-3 mt-6 pt-4 border-t border-[var(--border)]">
                        <button
                          onClick={() => { const p = mpPage - 1; setMpPage(p); loadMarketplace(mpSearch, mpCategory, p, mpSource); }}
                          disabled={mpPage <= 1}
                          className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 disabled:opacity-30 transition-colors flex items-center gap-1"
                        >
                          <ChevronLeft size={12} /> {t("mpPrevious")}
                        </button>
                        <div className="flex items-center gap-1">
                          {Array.from({ length: Math.min(7, mpTotalPages) }, (_, i) => {
                            let pageNum: number;
                            if (mpTotalPages <= 7) {
                              pageNum = i + 1;
                            } else if (mpPage <= 4) {
                              pageNum = i + 1;
                            } else if (mpPage >= mpTotalPages - 3) {
                              pageNum = mpTotalPages - 6 + i;
                            } else {
                              pageNum = mpPage - 3 + i;
                            }
                            return (
                              <button
                                key={pageNum}
                                onClick={() => { setMpPage(pageNum); loadMarketplace(mpSearch, mpCategory, pageNum, mpSource); }}
                                className={`w-8 h-8 text-xs rounded-lg transition-colors ${
                                  pageNum === mpPage
                                    ? "bg-[var(--accent)] text-white"
                                    : "hover:bg-white/5 text-[var(--muted)]"
                                }`}
                              >
                                {pageNum}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          onClick={() => { const p = mpPage + 1; setMpPage(p); loadMarketplace(mpSearch, mpCategory, p, mpSource); }}
                          disabled={mpPage >= mpTotalPages}
                          className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 disabled:opacity-30 transition-colors flex items-center gap-1"
                        >
                          {t("mpNext")} <ChevronRight size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ========== STAGING TAB (unified with Clones) ========== */}
              {activeTab === "staging" && (() => {
                // Find the staging clone from clones list
                const stagingClone = clones.find((c: any) => c.clone_type === "staging" && c.status !== "destroyed");
                const hasStaging = !!stagingClone;
                const isProduction = !instance.is_staging;

                const handleCreateStaging = async () => {
                  if (!confirm(t("stagingConfirmCreate"))) return;
                  setStagingAction("creating");
                  try {
                    await clonesApi.create({ source_instance_id: instanceId, clone_type: "staging", neutralize: true });
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setStagingAction(null); }
                };

                const handleSyncStaging = async () => {
                  if (!stagingClone) return;
                  if (!confirm(t("stagingConfirmSync"))) return;
                  setStagingAction("syncing");
                  try {
                    await clonesApi.sync(stagingClone.id);
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setStagingAction(null); }
                };

                const handleDeleteStaging = async () => {
                  if (!stagingClone) return;
                  if (!confirm(t("stagingConfirmDelete"))) return;
                  setStagingAction("deleting");
                  try {
                    await clonesApi.destroy(stagingClone.id);
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setStagingAction(null); }
                };

                const handleStartStaging = async () => {
                  if (!stagingClone) return;
                  setStagingAction("starting");
                  try {
                    await clonesApi.start(stagingClone.id);
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setStagingAction(null); }
                };

                const handleStopStaging = async () => {
                  if (!stagingClone) return;
                  setStagingAction("stopping");
                  try {
                    await clonesApi.stop(stagingClone.id);
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setStagingAction(null); }
                };

                const formatDate = (iso: string | null) => {
                  if (!iso) return t("never");
                  return new Date(iso).toLocaleString("it-IT", {
                    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
                  });
                };

                return (
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2">
                        <GitBranch size={15} /> {t("stagingTitle")}
                      </h3>
                      {hasStaging && (
                        <button onClick={loadClones} disabled={clonesLoading}
                          className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors flex items-center gap-1.5 text-xs">
                          <RefreshCw size={13} className={clonesLoading ? "animate-spin" : ""} /> {t("stagingRefresh")}
                        </button>
                      )}
                    </div>

                    {/* Loading */}
                    {clonesLoading && !stagingClone ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("stagingLoading")}</p>
                      </div>
                    ) : !isProduction ? (
                      /* This IS a staging instance */
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-6 text-center">
                        <GitBranch size={32} className="mx-auto text-amber-400 mb-3" />
                        <h4 className="text-base font-semibold mb-2 text-amber-400">{t("stagingIsStaging")}</h4>
                        <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
                          {t("stagingIsStagingDesc")}
                        </p>
                      </div>
                    ) : !hasStaging ? (
                      /* No staging yet — creation prompt */
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8">
                        <div className="max-w-lg mx-auto text-center">
                          <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-5">
                            <GitBranch size={28} className="text-[var(--accent)]" />
                          </div>
                          <h4 className="text-lg font-semibold mb-2">{t("stagingCreateTitle")}</h4>
                          <p className="text-sm text-[var(--muted)] mb-6">
                            {t("stagingCreateDesc")}
                          </p>

                          <div className="grid gap-3 max-w-md mx-auto text-left mb-6">
                            {[
                              { icon: Database, text: t("stagingFeature1") },
                              { icon: FolderOpen, text: t("stagingFeature2") },
                              { icon: FileText, text: t("stagingFeature3") },
                              { icon: Shield, text: t("stagingFeature4") },
                              { icon: RefreshCw, text: t("stagingFeature5") },
                            ].map((item, i) => (
                              <div key={i} className="flex items-start gap-3 text-sm">
                                <item.icon size={15} className="text-[var(--accent)] mt-0.5 shrink-0" />
                                <span className="text-[var(--muted)]">{item.text}</span>
                              </div>
                            ))}
                          </div>

                          <button
                            onClick={handleCreateStaging}
                            disabled={!!stagingAction || instance.status !== "running"}
                            className="px-5 py-2.5 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors inline-flex items-center gap-2 disabled:opacity-50"
                          >
                            {stagingAction === "creating" ? (
                              <><Loader2 size={14} className="animate-spin" /> {t("stagingCreating")}</>
                            ) : (
                              <><GitBranch size={14} /> {t("stagingCreateClone")}</>
                            )}
                          </button>
                          {instance.status !== "running" && (
                            <p className="text-xs text-amber-400 mt-2">{t("stagingMustBeRunning")}</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* Staging exists — show details */
                      <>
                        {/* Staging Status Card */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-2.5 h-2.5 rounded-full ${
                                stagingClone.status === "running" ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]" :
                                stagingClone.status === "cloning" || stagingClone.status === "neutralizing" || stagingClone.status === "pending" ? "bg-blue-400 animate-pulse" :
                                stagingClone.status === "failed" ? "bg-red-400" : "bg-zinc-400"
                              }`} />
                              <div>
                                <h4 className="text-sm font-semibold">{stagingClone.name}</h4>
                                <p className="text-xs text-[var(--muted)] capitalize">{stagingClone.status}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {stagingClone.neutralized && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center gap-1">
                                  <Shield size={10} /> {t("stagingNeutralized")}
                                </span>
                              )}
                              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">{t("stagingLabel")}</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                            <div>
                              <span className="text-xs text-[var(--muted)] block mb-0.5">{t("stagingDatabase")}</span>
                              <span className="font-medium font-mono text-xs">{stagingClone.clone_database || "—"}</span>
                            </div>
                            <div>
                              <span className="text-xs text-[var(--muted)] block mb-0.5">{t("schedulesStatusLabel")}</span>
                              <span className="font-medium capitalize">{stagingClone.status}</span>
                            </div>
                            <div>
                              <span className="text-xs text-[var(--muted)] block mb-0.5">{t("stagingCreated")}</span>
                              <span className="font-medium">{formatDate(stagingClone.created_at)}</span>
                            </div>
                            <div>
                              <span className="text-xs text-[var(--muted)] block mb-0.5">{t("stagingDuration")}</span>
                              <span className="font-medium">{stagingClone.duration_seconds ? `${stagingClone.duration_seconds}s` : "—"}</span>
                            </div>
                          </div>

                          {/* Staging URL */}
                          {stagingClone.base_url && stagingClone.status === "running" && (
                            <div className="mt-4 pt-4 border-t border-[var(--border)]">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm">
                                  <Globe size={14} className="text-[var(--muted)]" />
                                  <span className="text-[var(--muted)]">{t("stagingUrl")}:</span>
                                  <a href={stagingClone.base_url} target="_blank" rel="noopener noreferrer"
                                    className="text-[var(--accent)] hover:underline font-mono text-xs">{stagingClone.base_url}</a>
                                </div>
                                <a href={stagingClone.base_url} target="_blank" rel="noopener noreferrer"
                                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5">
                                  <ExternalLink size={12} /> {t("stagingOpen")}
                                </a>
                              </div>
                            </div>
                          )}

                          {/* Error display */}
                          {stagingClone.error_message && (
                            <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                              <AlertTriangle size={12} className="inline mr-1" /> {stagingClone.error_message}
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                          {/* Start / Stop */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2">
                              <Power size={14} className="text-emerald-400" />
                              <h4 className="text-sm font-semibold">{t("stagingContainer")}</h4>
                            </div>
                            <p className="text-xs text-[var(--muted)] mb-3">
                              {stagingClone.is_active ? t("stagingContainerRunning") : t("stagingContainerStart")}
                            </p>
                            {stagingClone.is_active ? (
                              <button
                                onClick={handleStopStaging}
                                disabled={!!stagingAction}
                                className="w-full px-3 py-2 text-xs rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                              >
                                {stagingAction === "stopping" ? (
                                  <><Loader2 size={12} className="animate-spin" /> {t("stagingStopping")}</>
                                ) : (
                                  <><Square size={12} /> {t("stagingStopContainer")}</>
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={handleStartStaging}
                                disabled={!!stagingAction || !["ready", "stopped"].includes(stagingClone.status)}
                                className="w-full px-3 py-2 text-xs rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                              >
                                {stagingAction === "starting" ? (
                                  <><Loader2 size={12} className="animate-spin" /> {t("stagingStarting")}</>
                                ) : (
                                  <><Play size={12} /> {t("stagingStartContainer")}</>
                                )}
                              </button>
                            )}
                          </div>

                          {/* Sync from Production */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2">
                              <RefreshCw size={14} className="text-blue-400" />
                              <h4 className="text-sm font-semibold">{t("stagingSyncFromProd")}</h4>
                            </div>
                            <p className="text-xs text-[var(--muted)] mb-3">
                              {t("stagingSyncDesc")}
                            </p>
                            <button
                              onClick={handleSyncStaging}
                              disabled={!!stagingAction}
                              className="w-full px-3 py-2 text-xs rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                              {stagingAction === "syncing" ? (
                                <><Loader2 size={12} className="animate-spin" /> {t("stagingSyncing")}</>
                              ) : (
                                <><RefreshCw size={12} /> {t("stagingSyncNow")}</>
                              )}
                            </button>
                          </div>

                          {/* Open Staging */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2">
                              <ExternalLink size={14} className="text-emerald-400" />
                              <h4 className="text-sm font-semibold">{t("stagingAccess")}</h4>
                            </div>
                            <p className="text-xs text-[var(--muted)] mb-3">
                              {t("stagingAccessDesc")}
                            </p>
                            {stagingClone.base_url && stagingClone.status === "running" ? (
                              <a href={stagingClone.base_url} target="_blank" rel="noopener noreferrer"
                                className="w-full px-3 py-2 text-xs rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-1.5">
                                <ExternalLink size={12} /> {t("stagingOpenInBrowser")}
                              </a>
                            ) : (
                              <button disabled className="w-full px-3 py-2 text-xs rounded-lg border border-[var(--border)] text-[var(--muted)] opacity-50 flex items-center justify-center gap-1.5">
                                <ExternalLink size={12} /> {t("stagingNotAvailable")}
                              </button>
                            )}
                          </div>

                          {/* Delete Staging */}
                          <div className="bg-[var(--card)] border border-red-500/10 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2">
                              <Trash2 size={14} className="text-red-400" />
                              <h4 className="text-sm font-semibold">{t("stagingDelete")}</h4>
                            </div>
                            <p className="text-xs text-[var(--muted)] mb-3">
                              {t("stagingDeleteDesc")}
                            </p>
                            <button
                              onClick={handleDeleteStaging}
                              disabled={!!stagingAction}
                              className="w-full px-3 py-2 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                              {stagingAction === "deleting" ? (
                                <><Loader2 size={12} className="animate-spin" /> {t("stagingDeleting")}</>
                              ) : (
                                <><Trash2 size={12} /> {t("stagingDeleteButton")}</>
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Info */}
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                          <h4 className="text-xs font-semibold text-[var(--muted)] mb-3 flex items-center gap-1.5"><Shield size={12} /> {t("stagingBestPractices")}</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                            <div className="flex items-start gap-2">
                              <CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                              <span>{t("stagingBp1")}</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                              <span>{t("stagingBp2")}</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                              <span>{t("stagingBp3")}</span>
                            </div>
                            <div className="flex items-start gap-2">
                              <CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" />
                              <span>{t("stagingBp4")}</span>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* ========== MONITORING TAB ========== */}
              {activeTab === "monitoring" && (() => {
                const md = monitoringData;
                const containers = md?.containers || {};
                const details = md?.container_details || {};
                const disk = md?.disk || {};
                const dbInfo = md?.database || {};
                const procs = md?.processes || {};
                const uptime = md?.uptime || {};
                const logsTail = md?.logs_tail || [];
                const isOnline = instance.status === "running";

                // Parse CPU/MEM from container stats for the Odoo container
                const prefix = instance.config?.prefix || `crx-odoo-${instance.id?.slice(0, 8)}`;
                const odooKey = Object.keys(containers).find(k => k.includes("odoo")) || "";
                const dbKey = Object.keys(containers).find(k => k.includes("db")) || "";
                const odooStats = containers[odooKey] || {};
                const dbStats = containers[dbKey] || {};
                const odooCpu = parseFloat(odooStats.cpu_percent || "0");
                const odooMem = parseFloat(odooStats.mem_percent || "0");
                const dbCpu = parseFloat(dbStats.cpu_percent || "0");
                const dbMem = parseFloat(dbStats.mem_percent || "0");
                const diskPct = disk?.host?.percent ? parseInt(disk.host.percent) : 0;

                const MetricBar = ({ label, value, pct, color, icon: Icon }: { label: string; value: string; pct: number; color: string; icon: any }) => (
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-[var(--muted)] flex items-center gap-1.5"><Icon size={13} /> {label}</span>
                      <span className={`text-sm font-semibold ${color}`}>{value}</span>
                    </div>
                    <div className="w-full h-2 bg-[var(--background)] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${pct > 85 ? "bg-red-400" : pct > 60 ? "bg-amber-400" : "bg-emerald-400"}`}
                        style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                  </div>
                );

                return (
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Activity size={15} /> {t("monitoringTitle")}</h3>
                      <button onClick={loadMonitoring} disabled={monitoringLoading}
                        className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors flex items-center gap-1.5 text-xs">
                        <RefreshCw size={13} className={monitoringLoading ? "animate-spin" : ""} /> {t("monitoringRefresh")}
                      </button>
                    </div>

                    {monitoringLoading && !md ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("monitoringCollecting")}</p>
                        <p className="text-[10px] text-[var(--muted)] mt-1">{t("monitoringCollectingDesc")}</p>
                      </div>
                    ) : !isOnline ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <WifiOff size={32} className="mx-auto text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("monitoringOffline")}</p>
                      </div>
                    ) : (
                      <>
                        {/* Container Resource Gauges */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MetricBar label={t("monitoringOdooCpu")} value={odooStats.cpu_percent || "0%"} pct={odooCpu} color={odooCpu > 85 ? "text-red-400" : odooCpu > 60 ? "text-amber-400" : "text-emerald-400"} icon={Cpu} />
                          <MetricBar label={t("monitoringOdooRam")} value={odooStats.mem_percent || "0%"} pct={odooMem} color={odooMem > 85 ? "text-red-400" : odooMem > 60 ? "text-amber-400" : "text-emerald-400"} icon={MemoryStick} />
                          <MetricBar label={t("monitoringDbCpu")} value={dbStats.cpu_percent || "0%"} pct={dbCpu} color={dbCpu > 85 ? "text-red-400" : "text-emerald-400"} icon={Database} />
                          <MetricBar label={t("monitoringDisk")} value={disk.host?.percent || "—"} pct={diskPct} color={diskPct > 85 ? "text-red-400" : diskPct > 60 ? "text-amber-400" : "text-emerald-400"} icon={HardDrive} />
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          {/* Container Details */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Layers size={14} /> {t("monitoringContainers")}</h3>
                            <div className="space-y-3">
                              {Object.entries(containers).map(([name, stats]: [string, any]) => {
                                const det = details[name] || {};
                                return (
                                  <div key={name} className="p-3 rounded-lg bg-[var(--background)] border border-white/[0.03]">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-xs font-mono font-medium text-white">{name}</span>
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${det.state === "running" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                                        {det.state || "unknown"}
                                      </span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--muted)]">
                                      <span>CPU: <span className="text-white">{stats.cpu_percent}</span></span>
                                      <span>RAM: <span className="text-white">{stats.mem_usage}</span></span>
                                      <span>Net: <span className="text-white">{stats.net_io}</span></span>
                                      <span>Disk: <span className="text-white">{stats.block_io}</span></span>
                                      <span>PIDs: <span className="text-white">{stats.pids}</span></span>
                                      {det.restart_count > 0 && <span>Restarts: <span className="text-amber-400">{det.restart_count}</span></span>}
                                    </div>
                                  </div>
                                );
                              })}
                              {Object.keys(containers).length === 0 && !containers.error && (
                                <p className="text-xs text-[var(--muted)] text-center py-4">{t("monitoringNoContainers")}</p>
                              )}
                            </div>
                          </div>

                          {/* Database & Performance */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Database size={14} /> {t("monitoringDbPerformance")}</h3>
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--muted)]">{t("monitoringDbSize")}</span>
                                <span className="text-sm font-medium">{dbInfo.size || "N/A"}</span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--muted)]">{t("monitoringActiveConnections")}</span>
                                <span className="text-sm font-medium">{dbInfo.active_connections ?? "—"} <span className="text-[var(--muted)]">/ {dbInfo.connections ?? "—"} total</span></span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--muted)]">{t("monitoringOdooWorkers")}</span>
                                <span className="text-sm font-medium">{procs.total_workers ?? "—"} <span className="text-[var(--muted)]">({procs.cron_workers ?? 0} cron)</span></span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--muted)]">{t("monitoringResponseTime")}</span>
                                <span className={`text-sm font-medium ${uptime.response_time_ms && uptime.response_time_ms > 2000 ? "text-red-400" : uptime.response_time_ms > 500 ? "text-amber-400" : "text-emerald-400"}`}>
                                  {uptime.response_time_ms != null ? `${uptime.response_time_ms}ms` : "N/A"}
                                </span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--muted)]">{t("monitoringHealth")}</span>
                                <span className="flex items-center gap-1.5 text-sm">
                                  {uptime.healthy ? (
                                    <><CheckCircle size={13} className="text-emerald-400" /> <span className="text-emerald-400">{t("monitoringHealthy")}</span></>
                                  ) : (
                                    <><XCircle size={13} className="text-red-400" /> <span className="text-red-400">{t("monitoringUnhealthy")}</span></>
                                  )}
                                </span>
                              </div>
                            </div>

                            {/* Disk breakdown */}
                            <div className="mt-4 pt-4 border-t border-white/[0.03]">
                              <h4 className="text-xs font-semibold text-[var(--muted)] mb-2">{t("monitoringDisk")}</h4>
                              <div className="space-y-1.5 text-xs">
                                {disk.host?.total && (
                                  <div className="flex justify-between"><span className="text-[var(--muted)]">{t("monitoringHost")}</span><span>{disk.host.used} / {disk.host.total} ({disk.host.percent})</span></div>
                                )}
                                {disk.deploy_dir_size && (
                                  <div className="flex justify-between"><span className="text-[var(--muted)]">{t("monitoringInstance")}</span><span>{disk.deploy_dir_size}</span></div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Live Log Tail */}
                          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 md:col-span-2">
                            <div className="flex items-center justify-between mb-3">
                              <h3 className="text-sm font-semibold flex items-center gap-2"><Terminal size={14} /> {t("monitoringLogTail")}</h3>
                              <button onClick={() => setActiveTab("logs")} className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1">
                                {t("monitoringFullLogs")} <ChevronRight size={12} />
                              </button>
                            </div>
                            {logsTail.length > 0 ? (
                              <div className="bg-black/30 rounded-lg p-3 max-h-56 overflow-y-auto font-mono text-[11px] leading-relaxed text-gray-300 space-y-0.5">
                                {logsTail.map((line: string, i: number) => (
                                  <div key={i} className={`${line.includes("ERROR") || line.includes("CRITICAL") ? "text-red-400" : line.includes("WARNING") ? "text-amber-400" : ""}`}>
                                    {line}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="bg-black/30 rounded-lg p-6 text-center">
                                <Terminal size={20} className="mx-auto text-[var(--muted)] mb-2" />
                                <p className="text-xs text-[var(--muted)]">{t("monitoringNoLogData")}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* ========== BACKUP SCHEDULES TAB ========== */}
              {activeTab === "schedules" && (() => {
                const cronPresets = [
                  { label: t("schedulesCronEvery6h"), value: "0 */6 * * *" },
                  { label: t("schedulesCronDaily2am"), value: "0 2 * * *" },
                  { label: t("schedulesCronDaily3am"), value: "0 3 * * *" },
                  { label: t("schedulesCronTwiceDaily"), value: "0 2,14 * * *" },
                  { label: t("schedulesCronWeekdays"), value: "30 1 * * 1-5" },
                  { label: t("schedulesCronWeekly"), value: "0 3 * * 0" },
                  { label: t("schedulesCronMonthly"), value: "0 3 1 * *" },
                ];

                const cronToHuman = (cron: string) => {
                  const preset = cronPresets.find(p => p.value === cron);
                  if (preset) return preset.label;
                  return cron;
                };

                const handleCreateSchedule = async () => {
                  setScheduleAction("creating");
                  try {
                    await backupSchedulesApi.create({ instance_id: instanceId, ...scheduleForm });
                    setShowScheduleModal(false);
                    await loadSchedules();
                  } catch (err: any) { alert(err.message); }
                  finally { setScheduleAction(null); }
                };

                const handleToggleSchedule = async (id: string) => {
                  try {
                    await backupSchedulesApi.toggle(id);
                    await loadSchedules();
                  } catch (err: any) { alert(err.message); }
                };

                const handleDeleteSchedule = async (id: string) => {
                  if (!confirm(t("schedulesConfirmDelete"))) return;
                  try {
                    await backupSchedulesApi.remove(id);
                    await loadSchedules();
                  } catch (err: any) { alert(err.message); }
                };

                const handleRunNow = async (id: string) => {
                  setScheduleAction(`run-${id}`);
                  try {
                    await backupSchedulesApi.runNow(id);
                    await loadSchedules();
                  } catch (err: any) { alert(err.message); }
                  finally { setScheduleAction(null); }
                };

                const formatDate = (iso: string | null) => {
                  if (!iso) return t("never");
                  return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
                };

                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Calendar size={15} /> {t("schedulesTitle")}</h3>
                      <button onClick={() => setShowScheduleModal(true)}
                        className="px-3 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2 disabled:opacity-50">
                        <Plus size={14} /> {t("schedulesNewSchedule")}
                      </button>
                    </div>

                    {/* RPO Indicator */}
                    {schedules.filter(s => s.enabled).length > 0 && (
                      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 flex items-center gap-3">
                        <Shield size={18} className="text-emerald-400 shrink-0" />
                        <div>
                          <span className="text-sm font-medium text-emerald-400">{t("schedulesDataProtection")}</span>
                          <p className="text-xs text-[var(--muted)] mt-0.5">
                            {t("schedulesActiveCount", { count: schedules.filter(s => s.enabled).length })} — Retention: {schedules[0]?.keep_daily || 7}d / {schedules[0]?.keep_weekly || 4}w / {schedules[0]?.keep_monthly || 12}m
                          </p>
                        </div>
                      </div>
                    )}

                    {schedulesLoading && schedules.length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("schedulesLoading")}</p>
                      </div>
                    ) : schedules.length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-5">
                          <Calendar size={28} className="text-[var(--accent)]" />
                        </div>
                        <h4 className="text-lg font-semibold mb-2">{t("schedulesNoSchedules")}</h4>
                        <p className="text-sm text-[var(--muted)] mb-4 max-w-md mx-auto">
                          {t("schedulesNoSchedulesDesc")}
                        </p>
                        <button onClick={() => setShowScheduleModal(true)}
                          className="px-5 py-2.5 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors inline-flex items-center gap-2">
                          <Plus size={14} /> {t("schedulesCreateFirst")}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {schedules.map((sched: any) => (
                          <div key={sched.id} className={`bg-[var(--card)] border rounded-xl p-5 ${sched.enabled ? "border-[var(--border)]" : "border-[var(--border)] opacity-60"}`}>
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-3">
                                <button onClick={() => handleToggleSchedule(sched.id)}
                                  className={`relative w-11 h-6 rounded-full transition-colors ${sched.enabled ? "bg-emerald-500" : "bg-gray-600"}`}>
                                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${sched.enabled ? "translate-x-5" : ""}`} />
                                </button>
                                <div>
                                  <span className="text-sm font-semibold">{cronToHuman(sched.cron_expression)}</span>
                                  <span className="text-xs text-[var(--muted)] ml-2">({sched.timezone})</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button onClick={() => handleRunNow(sched.id)} disabled={!sched.enabled || !!scheduleAction}
                                  className="px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                  {scheduleAction === `run-${sched.id}` ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t("schedulesRunNow")}
                                </button>
                                <button onClick={() => handleDeleteSchedule(sched.id)}
                                  className="p-1.5 text-[var(--muted)] hover:text-[var(--danger)] transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("schedulesFormat")}</span><span className="font-medium uppercase">{sched.backup_format}</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("schedulesFilestore")}</span><span className="font-medium">{sched.include_filestore ? t("schedulesIncluded") : t("schedulesDbOnly")}</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("schedulesRetention")}</span><span className="font-medium">{sched.keep_daily}d / {sched.keep_weekly}w / {sched.keep_monthly}m</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("schedulesLastRun")}</span><span className="font-medium">{formatDate(sched.last_run_at)}</span></div>
                              <div>
                                <span className="text-[var(--muted)] block mb-0.5">{t("schedulesStatusLabel")}</span>
                                <span className={`font-medium ${sched.last_status === "completed" ? "text-emerald-400" : sched.last_status === "failed" ? "text-red-400" : "text-[var(--muted)]"}`}>
                                  {sched.last_status || "—"} {sched.consecutive_failures > 0 && <span className="text-red-400">({sched.consecutive_failures} fails)</span>}
                                </span>
                              </div>
                            </div>
                            {sched.total_runs > 0 && (
                              <div className="mt-2 pt-2 border-t border-white/5 text-xs text-[var(--muted)]">
                                {t("schedulesTotalRuns", { count: sched.total_runs })} — {t("schedulesVerify")}: {sched.verify_after_backup ? t("yes") : t("no")} — {t("schedulesNotifications")}: {sched.notify_on_failure ? t("schedulesOnFailure") : t("off")}{sched.notify_on_success ? " + " + t("schedulesOnSuccess") : ""}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Create Schedule Modal */}
                    {showScheduleModal && (
                      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6 max-h-[80vh] overflow-y-auto">
                          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Calendar size={18} /> {t("schedulesNewBackupSchedule")}</h2>

                          <div className="space-y-4">
                            <div>
                              <label className="text-xs text-[var(--muted)] block mb-1">{t("schedulesScheduleLabel")}</label>
                              <select value={scheduleForm.cron_expression} onChange={(e) => setScheduleForm({ ...scheduleForm, cron_expression: e.target.value })}
                                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]">
                                {cronPresets.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                              </select>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs text-[var(--muted)] block mb-1">{t("schedulesFormat")}</label>
                                <select value={scheduleForm.backup_format} onChange={(e) => setScheduleForm({ ...scheduleForm, backup_format: e.target.value })}
                                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]">
                                  <option value="zip">{t("schedulesFormatZip")}</option>
                                  <option value="custom">{t("schedulesFormatCustom")}</option>
                                  <option value="sql">{t("schedulesFormatSql")}</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-[var(--muted)] block mb-1">{t("schedulesTimezone")}</label>
                                <select value={scheduleForm.timezone} onChange={(e) => setScheduleForm({ ...scheduleForm, timezone: e.target.value })}
                                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]">
                                  <option value="Europe/Rome">Europe/Rome</option>
                                  <option value="UTC">UTC</option>
                                  <option value="Europe/London">Europe/London</option>
                                  <option value="Europe/Berlin">Europe/Berlin</option>
                                  <option value="America/New_York">America/New_York</option>
                                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                                </select>
                              </div>
                            </div>

                            <div>
                              <label className="text-xs text-[var(--muted)] block mb-2">{t("schedulesRetentionPolicy")}</label>
                              <div className="grid grid-cols-3 gap-3">
                                <div>
                                  <label className="text-[10px] text-[var(--muted)] block mb-1">{t("schedulesDaily")}</label>
                                  <input type="number" min={1} max={90} value={scheduleForm.keep_daily}
                                    onChange={(e) => setScheduleForm({ ...scheduleForm, keep_daily: parseInt(e.target.value) || 7 })}
                                    className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]" />
                                </div>
                                <div>
                                  <label className="text-[10px] text-[var(--muted)] block mb-1">{t("schedulesWeekly")}</label>
                                  <input type="number" min={0} max={52} value={scheduleForm.keep_weekly}
                                    onChange={(e) => setScheduleForm({ ...scheduleForm, keep_weekly: parseInt(e.target.value) || 4 })}
                                    className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]" />
                                </div>
                                <div>
                                  <label className="text-[10px] text-[var(--muted)] block mb-1">{t("schedulesRetentionMonthly")}</label>
                                  <input type="number" min={0} max={60} value={scheduleForm.keep_monthly}
                                    onChange={(e) => setScheduleForm({ ...scheduleForm, keep_monthly: parseInt(e.target.value) || 12 })}
                                    className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]" />
                                </div>
                              </div>
                              <p className="text-[10px] text-[var(--muted)] mt-1">{t("schedulesMaxBackups", { count: scheduleForm.keep_daily + scheduleForm.keep_weekly + scheduleForm.keep_monthly })}</p>
                            </div>

                            <div className="space-y-2 border-t border-white/5 pt-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm">{t("schedulesIncludeFilestore")}</span>
                                <button onClick={() => setScheduleForm({ ...scheduleForm, include_filestore: !scheduleForm.include_filestore })}
                                  className={`relative w-11 h-6 rounded-full transition-colors ${scheduleForm.include_filestore ? "bg-emerald-500" : "bg-gray-600"}`}>
                                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${scheduleForm.include_filestore ? "translate-x-5" : ""}`} />
                                </button>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm">{t("schedulesVerifyAfterBackup")}</span>
                                <button onClick={() => setScheduleForm({ ...scheduleForm, verify_after_backup: !scheduleForm.verify_after_backup })}
                                  className={`relative w-11 h-6 rounded-full transition-colors ${scheduleForm.verify_after_backup ? "bg-emerald-500" : "bg-gray-600"}`}>
                                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${scheduleForm.verify_after_backup ? "translate-x-5" : ""}`} />
                                </button>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-sm">{t("schedulesNotifyOnFailure")}</span>
                                <button onClick={() => setScheduleForm({ ...scheduleForm, notify_on_failure: !scheduleForm.notify_on_failure })}
                                  className={`relative w-11 h-6 rounded-full transition-colors ${scheduleForm.notify_on_failure ? "bg-emerald-500" : "bg-gray-600"}`}>
                                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${scheduleForm.notify_on_failure ? "translate-x-5" : ""}`} />
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/5">
                            <button onClick={() => setShowScheduleModal(false)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-white">{tCommon("cancel")}</button>
                            <button onClick={handleCreateSchedule} disabled={!!scheduleAction}
                              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2">
                              {scheduleAction === "creating" ? <><Loader2 size={14} className="animate-spin" /> {t("schedulesCreatingSchedule")}</> : <><Plus size={14} /> {t("schedulesCreateSchedule")}</>}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ========== ENTERPRISE CLONES TAB ========== */}
              {activeTab === "clones" && (() => {
                const cloneTypeColors: Record<string, string> = {
                  staging: "bg-amber-500/10 text-amber-400",
                  development: "bg-blue-500/10 text-blue-400",
                  testing: "bg-purple-500/10 text-purple-400",
                  disaster_recovery: "bg-red-500/10 text-red-400",
                };

                const cloneStatusColors: Record<string, string> = {
                  pending: "text-[var(--muted)]", cloning: "text-blue-400", neutralizing: "text-amber-400",
                  ready: "text-emerald-400", running: "text-emerald-400", stopped: "text-[var(--muted)]",
                  failed: "text-red-400", destroyed: "text-red-400",
                };

                const formatDate = (iso: string | null) => {
                  if (!iso) return "—";
                  return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
                };

                const handleCreateClone = async () => {
                  setCloneAction("creating");
                  try {
                    await clonesApi.create({
                      source_instance_id: instanceId,
                      clone_type: cloneForm.clone_type,
                      name: cloneForm.name || undefined,
                      neutralize: cloneForm.neutralize,
                      base_url: cloneForm.base_url || undefined,
                    });
                    setShowCloneModal(false);
                    await loadClones();
                  } catch (err: any) { alert(err.message); }
                  finally { setCloneAction(null); }
                };

                const handleStartClone = async (id: string) => {
                  setCloneAction(`start-${id}`);
                  try { await clonesApi.start(id); await loadClones(); }
                  catch (err: any) { alert(err.message); }
                  finally { setCloneAction(null); }
                };

                const handleStopClone = async (id: string) => {
                  setCloneAction(`stop-${id}`);
                  try { await clonesApi.stop(id); await loadClones(); }
                  catch (err: any) { alert(err.message); }
                  finally { setCloneAction(null); }
                };

                const handleDestroyClone = async (id: string) => {
                  if (!confirm(t("clonesConfirmDestroy"))) return;
                  setCloneAction(`destroy-${id}`);
                  try { await clonesApi.destroy(id); await loadClones(); }
                  catch (err: any) { alert(err.message); }
                  finally { setCloneAction(null); }
                };

                const activeClone = clones.find(c => c.is_active);

                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Layers size={15} /> {t("clonesTitle")}</h3>
                      <div className="flex items-center gap-2">
                        <button onClick={loadClones} disabled={clonesLoading}
                          className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors">
                          <RefreshCw size={13} className={clonesLoading ? "animate-spin" : ""} />
                        </button>
                        <button onClick={() => setShowCloneModal(true)}
                          className="px-3 py-2 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2">
                          <Plus size={14} /> {t("clonesNewClone")}
                        </button>
                      </div>
                    </div>

                    {/* Token Safety Warning */}
                    {activeClone && (
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 flex items-center gap-3">
                        <AlertTriangle size={18} className="text-amber-400 shrink-0" />
                        <div>
                          <span className="text-sm font-medium text-amber-400">{t("clonesActiveClone", { name: activeClone.name })}</span>
                          <p className="text-xs text-[var(--muted)] mt-0.5">
                            {t("clonesActiveCloneDesc")}
                          </p>
                        </div>
                      </div>
                    )}

                    {clonesLoading && clones.length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                        <Loader2 size={24} className="mx-auto animate-spin text-[var(--muted)] mb-3" />
                        <p className="text-sm text-[var(--muted)]">{t("clonesLoading")}</p>
                      </div>
                    ) : clones.length === 0 ? (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mx-auto mb-5">
                          <Layers size={28} className="text-[var(--accent)]" />
                        </div>
                        <h4 className="text-lg font-semibold mb-2">{t("clonesNoClones")}</h4>
                        <p className="text-sm text-[var(--muted)] mb-4 max-w-md mx-auto">
                          {t("clonesNoDesc")}
                        </p>
                        <div className="grid gap-2 max-w-sm mx-auto text-left mb-6">
                          {[
                            { icon: Database, text: t("clonesFeatureDbClone") },
                            { icon: Shield, text: t("clonesFeatureNeutralize") },
                            { icon: Lock, text: t("clonesFeatureTokenSafety") },
                            { icon: Zap, text: t("clonesFeatureFastClone") },
                          ].map((item, i) => (
                            <div key={i} className="flex items-start gap-3 text-xs">
                              <item.icon size={14} className="text-[var(--accent)] mt-0.5 shrink-0" />
                              <span className="text-[var(--muted)]">{item.text}</span>
                            </div>
                          ))}
                        </div>
                        <button onClick={() => setShowCloneModal(true)}
                          className="px-5 py-2.5 text-sm rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors inline-flex items-center gap-2">
                          <Plus size={14} /> {t("clonesCreateFirst")}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {clones.map((clone: any) => (
                          <div key={clone.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-3">
                                <div className={`w-2.5 h-2.5 rounded-full ${
                                  clone.status === "running" ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]" :
                                  clone.status === "cloning" || clone.status === "neutralizing" ? "bg-blue-400 animate-pulse" :
                                  clone.status === "failed" ? "bg-red-400" :
                                  clone.status === "ready" ? "bg-emerald-400" : "bg-zinc-400"
                                }`} />
                                <div>
                                  <h4 className="text-sm font-semibold">{clone.name}</h4>
                                  <span className={`text-xs capitalize ${cloneStatusColors[clone.status] || "text-[var(--muted)]"}`}>{clone.status}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] px-2 py-0.5 rounded-full ${cloneTypeColors[clone.clone_type] || "bg-white/5 text-[var(--muted)]"}`}>
                                  {clone.clone_type}
                                </span>
                                {clone.neutralized && (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">{t("stagingNeutralized")}</span>
                                )}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("clonesDatabase")}</span><span className="font-medium font-mono">{clone.clone_database || "—"}</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("clonesCreated")}</span><span className="font-medium">{formatDate(clone.created_at)}</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("clonesDuration")}</span><span className="font-medium">{clone.duration_seconds ? `${clone.duration_seconds}s` : "—"}</span></div>
                              <div><span className="text-[var(--muted)] block mb-0.5">{t("clonesActive")}</span><span className={`font-medium ${clone.is_active ? "text-emerald-400" : ""}`}>{clone.is_active ? t("clonesActiveYes") : t("clonesActiveNo")}</span></div>
                            </div>

                            {/* Clone URL — visible when running */}
                            {clone.base_url && clone.status === "running" && (
                              <div className="mb-3 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg flex items-center justify-between">
                                <div className="flex items-center gap-2 text-xs">
                                  <Globe size={13} className="text-emerald-400" />
                                  <span className="text-[var(--muted)]">{t("clonesCloneUrl")}:</span>
                                  <a href={clone.base_url} target="_blank" rel="noopener noreferrer"
                                    className="text-[var(--accent)] hover:underline font-mono">{clone.base_url}</a>
                                </div>
                                <a href={clone.base_url} target="_blank" rel="noopener noreferrer"
                                  className="px-2.5 py-1 text-[10px] rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center gap-1">
                                  <ExternalLink size={10} /> {t("clonesOpen")}
                                </a>
                              </div>
                            )}

                            {clone.error_message && (
                              <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                                <AlertTriangle size={12} className="inline mr-1" /> {clone.error_message}
                              </div>
                            )}

                            <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                              {(clone.status === "ready" || clone.status === "stopped") && (
                                <button onClick={() => handleStartClone(clone.id)} disabled={!!cloneAction || (!!activeClone && activeClone.id !== clone.id)}
                                  className="px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                  {cloneAction === `start-${clone.id}` ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t("clonesStart")}
                                </button>
                              )}
                              {clone.status === "running" && (
                                <button onClick={() => handleStopClone(clone.id)} disabled={!!cloneAction}
                                  className="px-3 py-1.5 text-xs rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                  {cloneAction === `stop-${clone.id}` ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} {t("clonesStop")}
                                </button>
                              )}
                              {!["cloning", "neutralizing", "destroyed"].includes(clone.status) && (
                                <button onClick={() => handleDestroyClone(clone.id)} disabled={!!cloneAction}
                                  className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                  {cloneAction === `destroy-${clone.id}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {t("clonesDestroy")}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Clone Creation Modal */}
                    {showCloneModal && (
                      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-md p-6">
                          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2"><Layers size={18} /> {t("clonesCreateClone")}</h2>

                          <div className="space-y-4">
                            <div>
                              <label className="text-xs text-[var(--muted)] block mb-2">{t("clonesCloneType")}</label>
                              <div className="space-y-2">
                                {[
                                  { value: "staging", label: t("clonesTypeStaging"), desc: t("clonesTypeStagingDesc") },
                                  { value: "development", label: t("clonesTypeDevelopment"), desc: t("clonesTypeDevelopmentDesc") },
                                  { value: "testing", label: t("clonesTypeTesting"), desc: t("clonesTypeTestingDesc") },
                                  { value: "disaster_recovery", label: t("clonesTypeDisasterRecovery"), desc: t("clonesTypeDisasterRecoveryDesc") },
                                ].map((opt) => (
                                  <button key={opt.value} type="button"
                                    onClick={() => setCloneForm({ ...cloneForm, clone_type: opt.value })}
                                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                                      cloneForm.clone_type === opt.value
                                        ? "border-[var(--accent)] bg-[var(--accent)]/10"
                                        : "border-[var(--border)] hover:border-[var(--accent)]/40 hover:bg-white/[0.02]"
                                    }`}>
                                    <div className="flex items-center gap-2">
                                      <div className={`w-3 h-3 rounded-full border-2 transition-colors ${
                                        cloneForm.clone_type === opt.value ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--muted)]"
                                      }`} />
                                      <span className={`text-sm font-medium ${cloneForm.clone_type === opt.value ? "text-[var(--accent)]" : ""}`}>{opt.label}</span>
                                    </div>
                                    <p className="text-[11px] text-[var(--muted)] mt-1 ml-5">{opt.desc}</p>
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div>
                              <label className="text-xs text-[var(--muted)] block mb-1">{t("clonesNameOptional")}</label>
                              <input type="text" value={cloneForm.name} onChange={(e) => setCloneForm({ ...cloneForm, name: e.target.value })}
                                placeholder={`${instance?.name} — ${cloneForm.clone_type}`}
                                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]" />
                            </div>

                            <div className="space-y-2 border-t border-white/5 pt-3">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-sm">{t("clonesAutoNeutralize")}</span>
                                  <p className="text-[10px] text-[var(--muted)]">{t("clonesAutoNeutralizeDesc")}</p>
                                </div>
                                <button onClick={() => setCloneForm({ ...cloneForm, neutralize: !cloneForm.neutralize })}
                                  className={`relative w-11 h-6 rounded-full transition-colors ${cloneForm.neutralize ? "bg-emerald-500" : "bg-gray-600"}`}>
                                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${cloneForm.neutralize ? "translate-x-5" : ""}`} />
                                </button>
                              </div>
                            </div>

                            {!cloneForm.neutralize && (
                              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400 flex items-start gap-2">
                                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                                <span>{t("clonesNoNeutralizeWarning")}</span>
                              </div>
                            )}
                          </div>

                          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-white/5">
                            <button onClick={() => setShowCloneModal(false)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-white">{tCommon("cancel")}</button>
                            <button onClick={handleCreateClone} disabled={!!cloneAction}
                              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium flex items-center gap-2">
                              {cloneAction === "creating" ? <><Loader2 size={14} className="animate-spin" /> {t("clonesCreating")}</> : <><Layers size={14} /> {t("clonesCreateClone")}</>}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ========== MIGRATION TAB ========== */}
              {activeTab === "migration" && (() => {
                const migStatusColors: Record<string, string> = {
                  pending: "text-[var(--muted)]", preflight: "text-blue-400", backing_up: "text-blue-400",
                  stopping: "text-amber-400", dumping: "text-blue-400", transferring: "text-blue-400",
                  restoring: "text-blue-400", verifying: "text-amber-400", completed: "text-emerald-400",
                  failed: "text-red-400", rolled_back: "text-red-400",
                };

                const migStatusIcons: Record<string, typeof CheckCircle> = {
                  pending: Clock, preflight: Search, backing_up: Database, stopping: Square,
                  dumping: HardDrive, transferring: ArrowUpDown, restoring: Database,
                  verifying: Shield, completed: CheckCircle, failed: XCircle, rolled_back: Undo2,
                };

                const formatDate = (iso: string | null) => {
                  if (!iso) return "—";
                  return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
                };

                const formatDuration = (seconds: number | null) => {
                  if (!seconds) return "—";
                  if (seconds < 60) return `${seconds}s`;
                  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
                  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
                };

                const handleEstimate = async () => {
                  if (!migrationForm.target_server_id) return;
                  setMigrationAction("estimating");
                  try {
                    const est = await migrationsApi.estimate(instanceId, migrationForm.target_server_id);
                    setMigrationEstimate(est);
                  } catch (err: any) { alert(err.message); }
                  finally { setMigrationAction(null); }
                };

                const handleStartMigration = async () => {
                  if (!migrationForm.target_server_id) return;
                  if (!confirm(t("migrationConfirmStart"))) return;
                  setMigrationAction("migrating");
                  try {
                    await migrationsApi.create({
                      source_instance_id: instanceId,
                      target_server_id: migrationForm.target_server_id,
                      include_filestore: migrationForm.include_filestore,
                      target_database: migrationForm.target_database || undefined,
                    });
                    await loadMigrations();
                  } catch (err: any) { alert(err.message); }
                  finally { setMigrationAction(null); }
                };

                const otherServers = servers.filter(s => s.id !== instance?.server_id);
                const activeMig = migrations.find(m => !["completed", "failed", "rolled_back"].includes(m.status));

                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><ArrowUpDown size={15} /> {t("migrationTitle")}</h3>
                      <button onClick={loadMigrations} disabled={migrationsLoading}
                        className="p-2 rounded-lg border border-[var(--border)] hover:bg-white/5 text-[var(--muted)] hover:text-white transition-colors">
                        <RefreshCw size={13} className={migrationsLoading ? "animate-spin" : ""} />
                      </button>
                    </div>

                    {/* Active Migration Progress */}
                    {activeMig && (() => {
                      const StatusIcon = migStatusIcons[activeMig.status] || Clock;
                      const steps = ["preflight", "backing_up", "stopping", "dumping", "transferring", "restoring", "verifying", "completed"];
                      const currentIdx = steps.indexOf(activeMig.status);

                      return (
                        <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-5">
                          <div className="flex items-center gap-3 mb-4">
                            <Loader2 size={18} className="text-blue-400 animate-spin" />
                            <div>
                              <span className="text-sm font-semibold text-blue-400">{t("migrationInProgress")}</span>
                              <p className="text-xs text-[var(--muted)] capitalize">{activeMig.status.replace(/_/g, " ")}</p>
                            </div>
                          </div>
                          {/* Step Progress */}
                          <div className="flex items-center gap-1 mb-3">
                            {steps.map((step, i) => (
                              <div key={step} className={`h-1.5 flex-1 rounded-full transition-colors ${
                                i <= currentIdx ? "bg-blue-400" : "bg-white/10"
                              }`} />
                            ))}
                          </div>
                          <div className="flex justify-between text-[10px] text-[var(--muted)]">
                            <span>{t("migrationStepPreflight")}</span><span>{t("migrationStepDump")}</span><span>{t("migrationStepTransfer")}</span><span>{t("migrationStepVerify")}</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Migration Form */}
                    {!activeMig && (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                        <h4 className="text-sm font-semibold mb-3">{t("migrationNew")}</h4>
                        <p className="text-xs text-[var(--muted)] mb-4">
                          {t("migrationDesc")}
                        </p>

                        <div className="space-y-3">
                          <div>
                            <label className="text-xs text-[var(--muted)] block mb-1">{t("migrationTargetServer")}</label>
                            <select value={migrationForm.target_server_id}
                              onChange={(e) => { setMigrationForm({ ...migrationForm, target_server_id: e.target.value }); setMigrationEstimate(null); }}
                              className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]">
                              <option value="">{t("migrationSelectTarget")}</option>
                              {otherServers.map((s: any) => (
                                <option key={s.id} value={s.id}>{s.name} ({s.provider} — {s.endpoint})</option>
                              ))}
                            </select>
                            {otherServers.length === 0 && (
                              <p className="text-xs text-amber-400 mt-1">{t("migrationNoServers")}</p>
                            )}
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-sm">{t("migrationIncludeFilestore")}</span>
                            <button onClick={() => setMigrationForm({ ...migrationForm, include_filestore: !migrationForm.include_filestore })}
                              className={`relative w-11 h-6 rounded-full transition-colors ${migrationForm.include_filestore ? "bg-emerald-500" : "bg-gray-600"}`}>
                              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${migrationForm.include_filestore ? "translate-x-5" : ""}`} />
                            </button>
                          </div>

                          {migrationForm.target_server_id && (
                            <div className="flex gap-2">
                              <button onClick={handleEstimate} disabled={!!migrationAction}
                                className="px-3 py-2 text-xs rounded-lg border border-[var(--border)] hover:bg-white/5 transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                {migrationAction === "estimating" ? <Loader2 size={12} className="animate-spin" /> : <Gauge size={12} />} {t("migrationEstimate")}
                              </button>
                              <button onClick={handleStartMigration} disabled={!!migrationAction || instance?.status !== "running"}
                                className="px-3 py-2 text-xs rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-1.5 disabled:opacity-50">
                                {migrationAction === "migrating" ? <><Loader2 size={12} className="animate-spin" /> {t("migrationStarting")}</> : <><ArrowUpDown size={12} /> {t("migrationStartMigration")}</>}
                              </button>
                            </div>
                          )}

                          {/* Estimation Result */}
                          {migrationEstimate && (
                            <div className="mt-3 p-4 bg-[var(--background)] rounded-lg border border-[var(--border)]">
                              <h5 className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Gauge size={12} /> {t("migrationEstimateTitle")}</h5>
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                                <div><span className="text-[var(--muted)] block">{t("migrationEstimateDb")}</span><span className="font-medium">{migrationEstimate.database_size}</span></div>
                                <div><span className="text-[var(--muted)] block">{t("migrationEstimateFilestore")}</span><span className="font-medium">{migrationEstimate.filestore_size}</span></div>
                                <div><span className="text-[var(--muted)] block">{t("migrationTotal")}</span><span className="font-medium">{migrationEstimate.total_size}</span></div>
                                <div><span className="text-[var(--muted)] block">{t("migrationEstTime")}</span><span className="font-medium">{migrationEstimate.estimated_minutes} min</span></div>
                                <div><span className="text-[var(--muted)] block">{t("migrationSpaceNeeded")}</span><span className="font-medium">{migrationEstimate.space_needed}</span></div>
                                <div>
                                  <span className="text-[var(--muted)] block">{t("migrationSpaceAvailable")}</span>
                                  <span className={`font-medium ${migrationEstimate.space_sufficient === false ? "text-red-400" : migrationEstimate.space_sufficient ? "text-emerald-400" : ""}`}>
                                    {migrationEstimate.space_available} {migrationEstimate.space_sufficient === false && t("migrationInsufficient")}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* {t("migrationHistory")} */}
                    {migrations.length > 0 && (
                      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                        <h4 className="text-xs font-semibold text-[var(--muted)] mb-3 flex items-center gap-1.5"><History size={12} /> {t("migrationHistory")}</h4>
                        <div className="space-y-2">
                          {migrations.map((mig: any) => {
                            const StatusIcon = migStatusIcons[mig.status] || Clock;
                            return (
                              <div key={mig.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                                <div className="flex items-center gap-3">
                                  <StatusIcon size={14} className={migStatusColors[mig.status] || "text-[var(--muted)]"} />
                                  <div>
                                    <span className={`text-xs font-medium capitalize ${migStatusColors[mig.status]}`}>{mig.status.replace(/_/g, " ")}</span>
                                    <span className="text-[10px] text-[var(--muted)] ml-2">{formatDate(mig.created_at)}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
                                  {mig.source_db_size_mb && <span>{mig.source_db_size_mb} MB</span>}
                                  <span>{formatDuration(mig.duration_seconds)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Best Practices */}
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
                      <h4 className="text-xs font-semibold text-[var(--muted)] mb-3 flex items-center gap-1.5"><Shield size={12} /> {t("migrationBestPractices")}</h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                        <div className="flex items-start gap-2"><CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" /><span>{t("migrationBp1")}</span></div>
                        <div className="flex items-start gap-2"><CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" /><span>{t("migrationBp2")}</span></div>
                        <div className="flex items-start gap-2"><CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" /><span>{t("migrationBp3")}</span></div>
                        <div className="flex items-start gap-2"><CheckCircle size={12} className="text-emerald-400 mt-0.5 shrink-0" /><span>{t("migrationBp4")}</span></div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ========== SETTINGS TAB ========== */}
              {activeTab === "settings" && (
                <div className="space-y-5">
                  {/* Enterprise Upgrade Progress */}
                  {instance?.status === "upgrading" && instance?.config?.enterprise_progress && (
                    <div className="bg-blue-900/30 border border-blue-500/30 rounded-xl p-5">
                      <div className="flex items-center gap-3">
                        <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                        <div>
                          <h4 className="text-sm font-semibold text-blue-300">{t("settingsEnterpriseActivating")}</h4>
                          <p className="text-xs text-blue-400 mt-1">{instance.config.enterprise_progress}</p>
                          <p className="text-xs text-gray-500 mt-1">{t("settingsDoNotClose")}</p>
                        </div>
                      </div>
                    </div>
                  )}
                  {instance?.config?.enterprise_error && !enterpriseBusy && (
                    <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
                      <div className="flex items-center gap-2 text-sm text-red-400">
                        <XCircle className="w-4 h-4 shrink-0" />
                        <span>{t("settingsEnterpriseActivationFailed", { error: instance.config.enterprise_error })}</span>
                      </div>
                    </div>
                  )}
                  {enterpriseToast && (
                    <div className={`rounded-xl p-4 flex items-center gap-2 text-sm transition-all ${
                      enterpriseToast.type === "success"
                        ? "bg-emerald-900/20 border border-emerald-500/30 text-emerald-400"
                        : "bg-red-900/20 border border-red-500/30 text-red-400"
                    }`}>
                      {enterpriseToast.type === "success" ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                      <span>{enterpriseToast.message}</span>
                    </div>
                  )}

                  {/* Domain & SSL */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold flex items-center gap-2"><Globe size={15} className="text-blue-400" /> {t("settingsDomainSsl")}</h3>
                      <button onClick={() => { setDomainForm({ domain: instance?.domain || "", aliases: instance?.config?.aliases || [], http_redirect: instance?.config?.http_redirect ?? true }); setShowDomainModal(true); }}
                        className="px-3 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg transition-colors">
                        {t("settingsEditDomain")}
                      </button>
                    </div>
                    <div className="space-y-2 text-sm mb-4">
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsPrimaryDomain")}</span><span>{instance?.domain || "\u2014"}</span></div>
                      {instance?.config?.aliases?.length > 0 && (
                        <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsAliases")}</span><span>{instance.config.aliases.join(", ")}</span></div>
                      )}
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsHttpsRedirect")}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${instance?.config?.http_redirect !== false ? "bg-emerald-500/10 text-emerald-400" : "bg-white/5 text-[var(--muted)]"}`}>
                          {instance?.config?.http_redirect !== false ? t("settingsEnabled") : t("settingsDisabled")}
                        </span>
                      </div>
                    </div>
                    <div className="border-t border-white/[0.05] pt-4">
                      <SettingToggle label={t("settingsAutoSsl")} description={t("settingsAutoSslDesc")}
                        checked={instance?.config?.auto_ssl !== false}
                        onChange={(v) => handleSaveSettings("auto_ssl", v)}
                        disabled={instance?.status === "upgrading"} />
                    </div>
                  </div>

                  {/* Instance Lifecycle */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Settings2 size={15} /> {t("settingsInstanceLifecycle")}</h3>
                    <div className="space-y-1">
                      <SettingToggle label={t("settingsAutoUpdate")} description={t("settingsAutoUpdateDesc")}
                        checked={instance?.config?.auto_update === true}
                        onChange={(v) => handleSaveSettings("auto_update", v)}
                        disabled={instance?.status === "upgrading"} />
                      <SettingToggle label={t("settingsAutoRestart")} description={t("settingsAutoRestartDesc")}
                        checked={true} onChange={() => {}} disabled={true} />
                    </div>
                  </div>

                  {/* Enterprise Edition */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                      <Sparkles size={15} className="text-[var(--accent)]" /> {t("settingsEnterprise")}
                    </h3>
                    <div className="space-y-1">
                      <SettingToggle
                        label={t("settingsEnterpriseLabel")}
                        description={
                          instance?.status === "upgrading" ? t("settingsEnterpriseActivatingDesc") :
                          instance?.config?.enterprise === true ? t("settingsEnterpriseActive") :
                          enterprisePackages.find((p: any) => p.version === instance?.version) ? t("settingsEnterpriseEnable") :
                          t("settingsEnterpriseUploadRequired", { version: instance?.version })
                        }
                        checked={instance?.config?.enterprise === true}
                        onChange={(v) => handleSaveSettings("enterprise", v)}
                        disabled={instance?.status === "upgrading" || enterpriseBusy || !enterprisePackages.find((p: any) => p.version === instance?.version)}
                        loading={enterpriseBusy}
                      />
                      {instance?.config?.enterprise === true && (
                        <>
                          <SettingToggle
                            label={t("settingsBypassLicense")}
                            description={t("settingsBypassLicenseDesc")}
                            checked={instance?.config?.enterprise_bypass_license === true}
                            onChange={(v) => handleSaveSettings("enterprise_bypass_license", v)}
                            disabled={instance?.status === "upgrading"}
                          />
                          {instance?.config?.enterprise_bypass_license === true && (
                            <div className="py-3 border-b border-white/5 last:border-0 pl-4">
                              <div className="text-white font-medium text-sm">{t("settingsBypassUuid")}</div>
                              <div className="text-gray-400 text-xs mt-0.5 mb-2">{t("settingsBypassUuidDesc")}</div>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                  defaultValue={instance?.config?.enterprise_bypass_uuid || ""}
                                  className="flex-1 bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-white font-mono placeholder:text-gray-600"
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      handleSaveSettings("enterprise_bypass_uuid", (e.target as HTMLInputElement).value.trim());
                                    }
                                  }}
                                  id="bypass-uuid-input"
                                />
                                <button
                                  className="px-3 py-1.5 bg-[var(--accent)] text-black rounded-lg text-xs font-semibold hover:opacity-90"
                                  onClick={() => {
                                    const input = document.getElementById("bypass-uuid-input") as HTMLInputElement;
                                    if (input) handleSaveSettings("enterprise_bypass_uuid", input.value.trim());
                                  }}
                                >
                                  {tCommon("save")}
                                </button>
                                {instance?.config?.enterprise_bypass_uuid && (
                                  <button
                                    className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded-lg text-xs font-semibold hover:bg-red-500/30"
                                    onClick={() => handleSaveSettings("enterprise_bypass_uuid", "")}
                                  >
                                    {tCommon("remove")}
                                  </button>
                                )}
                              </div>
                              {instance?.config?.enterprise_bypass_uuid && (
                                <div className="mt-2 text-xs text-green-400 flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full inline-block" />
                                  {t("settingsBypassUuidActive")}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    {instance?.config?.enterprise && instance?.config?.enterprise_revision_date && (
                      <p className="text-[10px] text-[var(--muted)] mt-3 pt-3 border-t border-white/[0.05]">
                        {t("settingsEnterpriseRevision", { date: instance.config.enterprise_revision_date })}
                      </p>
                    )}
                  </div>

                  {/* Notifications & Alerts */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Bell size={15} /> {t("settingsNotifications")}</h3>
                    <div className="space-y-1">
                      <SettingToggle label={t("settingsErrorAlerts")} description={t("settingsErrorAlertsDesc")}
                        checked={settingsForm.notify_on_error} onChange={(v) => setSettingsForm(f => ({ ...f, notify_on_error: v }))} />
                      <SettingToggle label={t("settingsBackupAlerts")} description={t("settingsBackupAlertsDesc")}
                        checked={settingsForm.notify_on_backup} onChange={(v) => setSettingsForm(f => ({ ...f, notify_on_backup: v }))} />
                      <SettingToggle label={t("settingsResourceAlerts")} description={t("settingsResourceAlertsDesc")}
                        checked={settingsForm.notify_on_resources ?? false} onChange={(v) => setSettingsForm(f => ({ ...f, notify_on_resources: v }))} />
                      <SettingToggle label={t("settingsSslExpiryAlerts")} description={t("settingsSslExpiryAlertsDesc")}
                        checked={settingsForm.notify_ssl_expiry ?? true} onChange={(v) => setSettingsForm(f => ({ ...f, notify_ssl_expiry: v }))} />
                    </div>
                  </div>

                  {/* Instance Info (read-only) */}
                  <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Server size={15} /> {t("settingsInstanceDetails")}</h3>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsInstanceId")}</span><span className="font-mono text-xs">{instance.id}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsCmsType")}</span><span className="capitalize">{instance.cms_type}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsVersion")}</span><span>{instance.version}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsEdition")}</span><span className="capitalize">{instance.config?.edition || "community"}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsWorkers")}</span><span>{instance.workers}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsRam")}</span><span>{instance.ram_mb >= 1024 ? `${(instance.ram_mb / 1024).toFixed(1)} GB` : `${instance.ram_mb} MB`}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsCpuCores")}</span><span>{instance.cpu_cores}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsPort")}</span><span className="font-mono">{instance.config?.port || 8069}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsDatabase")}</span><span className="font-mono">{instance.config?.db_name || instance.name}</span></div>
                      <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsCreated")}</span><span>{instance.created_at ? new Date(instance.created_at).toLocaleDateString("it-IT") : "N/A"}</span></div>
                      {server && (
                        <>
                          <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsServer")}</span><span>{server.name}</span></div>
                          <div className="flex justify-between"><span className="text-[var(--muted)]">{t("settingsIp")}</span><span className="font-mono">{server.endpoint}</span></div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Danger Zone */}
                  <div className="bg-[var(--card)] border border-[var(--danger)]/30 rounded-xl p-5">
                    <h3 className="text-sm font-semibold mb-1 text-[var(--danger)] flex items-center gap-2"><AlertTriangle size={14} /> {t("settingsDangerZone")}</h3>
                    <p className="text-xs text-[var(--muted)] mb-4">{t("settingsDangerZoneDesc")}</p>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between p-3 border border-[var(--danger)]/20 rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{t("settingsRestartInstance")}</p>
                          <p className="text-xs text-[var(--muted)]">{t("settingsRestartDesc")}</p>
                        </div>
                        <button onClick={() => handleAction("restart")} disabled={!!actionLoading || instance.status !== "running"}
                          className="px-3 py-1.5 text-xs rounded-lg border border-amber-500/50 text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50 shrink-0">
                          {actionLoading === "restart" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {t("restart")}
                        </button>
                      </div>
                      <div className="flex items-center justify-between p-3 border border-[var(--danger)]/20 rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{t("settingsDeleteInstance")}</p>
                          <p className="text-xs text-[var(--muted)]">{t("settingsDeleteDesc", { name: instance.name })}</p>
                        </div>
                        <button onClick={handleDelete} disabled={!!actionLoading}
                          className="px-3 py-1.5 text-xs rounded-lg border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50 shrink-0">
                          {actionLoading === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {tCommon("delete")}
                        </button>
                      </div>
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
                  <GitBranch size={18} /> {t("modalAddGitRepo")}
                </h3>
                <button onClick={() => setShowAddGitModal(false)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalGitRepoUrl")}</label>
                  <input
                    value={gitAddonForm.url}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, url: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder="https://github.com/org/repo.git"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalBranch")}</label>
                  <input
                    value={gitAddonForm.branch}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, branch: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder={instance?.version || "17.0"}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalAccessToken")} <span className="text-gray-500 font-normal">{t("modalAccessTokenOptional")}</span></label>
                  <input
                    value={gitAddonForm.access_token}
                    onChange={(e) => setGitAddonForm({ ...gitAddonForm, access_token: e.target.value })}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder="ghp_xxxx or glpat-xxxx"
                    type="password"
                    autoComplete="off"
                  />
                  <p className="text-xs text-gray-500 mt-1">{t("modalAccessTokenHint")}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">{t("modalCopyMethod")}</label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copy_method"
                        checked={gitAddonForm.copy_method === "all"}
                        onChange={() => setGitAddonForm({ ...gitAddonForm, copy_method: "all" })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-sm text-white">{t("modalCopyAll")}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="copy_method"
                        checked={gitAddonForm.copy_method === "specific"}
                        onChange={() => setGitAddonForm({ ...gitAddonForm, copy_method: "specific" })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-sm text-white">{t("modalCopySpecific")}</span>
                    </label>
                  </div>
                </div>

                {gitAddonForm.copy_method === "specific" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalModuleNames")}</label>
                    <input
                      value={gitAddonForm.specific_addons}
                      onChange={(e) => setGitAddonForm({ ...gitAddonForm, specific_addons: e.target.value })}
                      className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                      placeholder="module_a, module_b, module_c"
                    />
                    <p className="text-xs text-gray-500 mt-1">{t("modalModuleNamesHint")}</p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowAddGitModal(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                >
                  {tCommon("cancel")}
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
                      alert(e.message || t("modalFailedAddGitAddon"));
                    } finally {
                      setGitAddonAdding(false);
                    }
                  }}
                  disabled={!gitAddonForm.url.trim() || gitAddonAdding}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {gitAddonAdding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {t("modalAddModule")}
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
                  <Library size={18} /> {t("modalOcaTitle")}
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
                  placeholder={t("modalOcaSearch")}
                  autoFocus
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
                {ocaCatalog.length === 0 ? (
                  <div className="text-center py-8">
                    <Loader2 size={20} className="mx-auto animate-spin text-[var(--muted)] mb-2" />
                    <p className="text-sm text-[var(--muted)]">{t("modalOcaLoading")}</p>
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
                      return <p className="text-sm text-[var(--muted)] text-center py-4">{t("modalOcaNoResults")}</p>;
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
                              <Plus size={12} /> {t("modalOcaAdd")}
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

        {/* Add from GitHub Modal */}
        {showGithubReposModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) { setShowGithubReposModal(false); setGhSelectedRepo(null); } }}
            onKeyDown={(e) => { if (e.key === "Escape") { setShowGithubReposModal(false); setGhSelectedRepo(null); } }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Github size={18} /> {ghSelectedRepo ? t("modalGhSelectBranch") : t("modalGhAddFromGithub")}
                </h3>
                <button onClick={() => { setShowGithubReposModal(false); setGhSelectedRepo(null); }} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              {!ghSelectedRepo ? (
                <>
                  {/* Search repos */}
                  <div className="relative mb-4">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                    <input
                      value={ghRepoSearch}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGhRepoSearch(val);
                        if (ghRepoSearchDebounce) clearTimeout(ghRepoSearchDebounce);
                        setGhRepoSearchDebounce(setTimeout(async () => {
                          setGhReposLoading(true);
                          try {
                            const data = await githubApi.repos({ search: val, per_page: 30 });
                            setGhRepos(data.repos || []);
                          } catch { setGhRepos([]); }
                          finally { setGhReposLoading(false); }
                        }, 400));
                      }}
                      className="w-full pl-9 pr-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                      placeholder={t("modalGhSearchRepos")}
                      autoFocus
                    />
                  </div>

                  {/* GitHub user info */}
                  {githubUsername && (
                    <p className="text-xs text-[var(--muted)] mb-3 flex items-center gap-1.5">
                      {githubAvatar && <img src={githubAvatar} alt="" className="w-4 h-4 rounded-full" />}
                      {t("modalGhBrowsingRepos")} <strong className="text-white">{githubUsername}</strong>
                    </p>
                  )}

                  {/* Repo list */}
                  <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                    {ghReposLoading ? (
                      <div className="text-center py-8">
                        <Loader2 size={20} className="mx-auto animate-spin text-[var(--muted)] mb-2" />
                        <p className="text-sm text-[var(--muted)]">{t("modalGhLoadingRepos")}</p>
                      </div>
                    ) : ghRepos.length === 0 ? (
                      <p className="text-sm text-[var(--muted)] text-center py-8">{t("modalGhNoRepos")}</p>
                    ) : (
                      ghRepos.map((repo: any) => (
                        <button
                          key={repo.full_name}
                          onClick={async () => {
                            setGhSelectedRepo(repo);
                            setGhBranches([]);
                            setGhSelectedBranch(repo.default_branch || "main");
                            // Load branches
                            try {
                              const [owner, name] = repo.full_name.split("/");
                              const data = await githubApi.branches(owner, name);
                              setGhBranches(data.branches || []);
                            } catch {
                              setGhBranches([{ name: repo.default_branch || "main", protected: false }]);
                            }
                          }}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/5 hover:bg-white/5 hover:border-[var(--accent)]/30 transition-colors text-left"
                        >
                          {repo.owner_avatar && <img src={repo.owner_avatar} alt="" className="w-6 h-6 rounded-full shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white truncate">{repo.full_name}</span>
                              {repo.private && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0 flex items-center gap-0.5">
                                  <Shield size={8} /> {t("modalGithubPrivate")}
                                </span>
                              )}
                            </div>
                            {repo.description && (
                              <p className="text-xs text-[var(--muted)] mt-0.5 truncate">{repo.description}</p>
                            )}
                          </div>
                          {repo.language && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[var(--muted)] shrink-0">{repo.language}</span>
                          )}
                          <ChevronRight size={14} className="text-[var(--muted)] shrink-0" />
                        </button>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Back button + Selected repo info */}
                  <button
                    onClick={() => { setGhSelectedRepo(null); setGhBranches([]); }}
                    className="flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline mb-4"
                  >
                    <ChevronLeft size={14} /> {t("modalGhBackToRepos")}
                  </button>

                  <div className="p-4 rounded-xl bg-black/30 border border-white/5 mb-4">
                    <div className="flex items-center gap-3">
                      {ghSelectedRepo.owner_avatar && <img src={ghSelectedRepo.owner_avatar} alt="" className="w-8 h-8 rounded-full" />}
                      <div>
                        <p className="text-sm font-medium text-white">{ghSelectedRepo.full_name}</p>
                        {ghSelectedRepo.description && (
                          <p className="text-xs text-[var(--muted)] mt-0.5">{ghSelectedRepo.description}</p>
                        )}
                      </div>
                      {ghSelectedRepo.private && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 flex items-center gap-0.5 ml-auto">
                          <Shield size={8} /> {t("modalGithubPrivate")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Branch selector */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">{t("modalGhSelectBranchLabel")}</label>
                    {ghBranches.length === 0 ? (
                      <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                        <Loader2 size={14} className="animate-spin" /> {t("modalGhLoadingBranches")}
                      </div>
                    ) : (
                      <div className="space-y-1 max-h-[200px] overflow-y-auto">
                        {ghBranches.map(b => (
                          <button
                            key={b.name}
                            onClick={() => setGhSelectedBranch(b.name)}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                              ghSelectedBranch === b.name
                                ? "border-[var(--accent)] bg-[var(--accent)]/10 text-white"
                                : "border-white/5 hover:bg-white/5 text-[var(--muted)]"
                            }`}
                          >
                            <GitBranch size={12} />
                            <span className="flex-1">{b.name}</span>
                            {b.name === ghSelectedRepo.default_branch && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-[var(--muted)]">{t("modalGhDefault")}</span>
                            )}
                            {ghSelectedBranch === b.name && <CheckCircle size={14} className="text-[var(--accent)]" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Add button */}
                  <div className="flex justify-end gap-3 mt-2">
                    <button
                      onClick={() => { setShowGithubReposModal(false); setGhSelectedRepo(null); }}
                      className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                    >
                      {tCommon("cancel")}
                    </button>
                    <button
                      onClick={async () => {
                        if (!ghSelectedRepo || !ghSelectedBranch) return;
                        setGhAddingRepo(true);
                        try {
                          await instancesApi.addGitAddon(instanceId, {
                            url: ghSelectedRepo.clone_url,
                            branch: ghSelectedBranch,
                          });
                          setShowGithubReposModal(false);
                          setGhSelectedRepo(null);
                          loadAddons();
                        } catch (e: any) {
                          alert(e.message || t("modalGhFailedAddRepo"));
                        } finally {
                          setGhAddingRepo(false);
                        }
                      }}
                      disabled={ghAddingRepo || !ghSelectedBranch}
                      className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
                    >
                      {ghAddingRepo ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                      {t("modalGhAddRepository")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Upload to GitHub Modal */}
        {showUploadGithubModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowUploadGithubModal(false); }}
          >
            <div className="bg-[var(--card)] border border-white/10 rounded-2xl p-6 w-full max-w-lg mx-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">{t("modalGhSetup")}</h3>
                <button onClick={() => setShowUploadGithubModal(false)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <p className="text-sm text-[var(--muted)] mb-5">
                {t("modalGhSetupDesc", { username: githubUsername })}
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">{t("modalGhRepoName")}</label>
                  <input
                    value={ghUploadRepoName}
                    onChange={(e) => setGhUploadRepoName(e.target.value.replace(/[^a-zA-Z0-9._-]/g, "-"))}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm"
                    placeholder="my-odoo-addons"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">{t("modalGhRepoDesc")}</label>
                  <textarea
                    value={ghUploadRepoDesc}
                    onChange={(e) => setGhUploadRepoDesc(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm resize-y"
                    placeholder="Repository managed by CRX Cloud to store instance addons"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowUploadGithubModal(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                >
                  {tCommon("cancel")}
                </button>
                <button
                  onClick={async () => {
                    if (!ghUploadRepoName.trim()) return;
                    setGhUploading(true);
                    try {
                      await instancesApi.uploadToGithub(instanceId, {
                        repo_name: ghUploadRepoName.trim(),
                        description: ghUploadRepoDesc.trim(),
                      });
                      setShowUploadGithubModal(false);
                      loadAddons();
                    } catch (e: any) {
                      alert(e.message || t("modalGhFailedCreateRepo"));
                    } finally {
                      setGhUploading(false);
                    }
                  }}
                  disabled={ghUploading || !ghUploadRepoName.trim()}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {ghUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  {t("modalGhCreateRepo")}
                </button>
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
                  <Settings2 size={18} /> {showAddonSettingsModal.type === "marketplace" ? t("modalModuleSettings") : t("modalRepoSettings")}
                </h3>
                <button onClick={() => setShowAddonSettingsModal(null)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <p className="text-sm text-[var(--muted)] mb-4">
                {showAddonSettingsModal.display_name || showAddonSettingsModal.name || showAddonSettingsModal.url?.replace(/\.git$/, "").split("/").slice(-2).join("/")}
              </p>

              <div className="space-y-1">
                <SettingToggle
                  label={t("modalAutoUpdateOnPush")}
                  description={t("modalAutoUpdateOnPushDesc")}
                  checked={showAddonSettingsModal.auto_update ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { auto_update: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, auto_update: v });
                      loadAddons();
                    } catch (e: any) { alert(e.message || t("modalFailedSaveSetting")); }
                  }}
                />
                <SettingToggle
                  label={t("modalInstallPythonReqs")}
                  description={t("modalInstallPythonReqsDesc")}
                  checked={showAddonSettingsModal.auto_install_requirements ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { auto_install_requirements: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, auto_install_requirements: v });
                      loadAddons();
                    } catch (e: any) { alert(e.message || t("modalFailedSaveSetting")); }
                  }}
                />
                <SettingToggle
                  label={t("modalAutoUpgradeModules")}
                  description={t("modalAutoUpgradeModulesDesc")}
                  checked={showAddonSettingsModal.auto_upgrade_modules ?? false}
                  onChange={async (v) => {
                    try {
                      await instancesApi.updateAddonSettings(instanceId, showAddonSettingsModal.id, { auto_upgrade_modules: v });
                      setShowAddonSettingsModal({ ...showAddonSettingsModal, auto_upgrade_modules: v });
                      loadAddons();
                    } catch (e: any) { alert(e.message || t("modalFailedSaveSetting")); }
                  }}
                />
              </div>

              {/* Webhook URL */}
              {instance?.config?.webhook_secret && (
                <div className="mt-4 p-3 rounded-lg bg-black/30 border border-white/5">
                  <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t("modalWebhookUrl")}</label>
                  <div className="flex items-center gap-2">
                    <code className="text-xs text-white/80 break-all flex-1">
                      {typeof window !== "undefined" ? window.location.origin : ""}/api/v1/instances/{instanceId}/addons/webhook/{instance.config.webhook_secret}
                    </code>
                    <button
                      onClick={() => {
                        const url = `${window.location.origin}/api/v1/instances/${instanceId}/addons/webhook/${instance.config.webhook_secret}`;
                        navigator.clipboard.writeText(url);
                      }}
                      className="p-1 text-[var(--muted)] hover:text-white shrink-0"
                      title={t("modalCopyWebhookUrl")}
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <p className="text-[10px] text-[var(--muted)] mt-1">{t("modalWebhookUrlDesc")}</p>
                </div>
              )}

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setShowAddonSettingsModal(null)}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm"
                >
                  {t("close")}
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
                  <RefreshCw size={18} /> {t("modalUpdateAddon")}
                </h3>
                <button onClick={() => setShowUpdateModal(null)} className="text-gray-400 hover:text-white">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">{t("modalUpdateBranch")}</span>
                  <span className="text-sm font-mono text-white flex items-center gap-1">
                    <GitBranch size={12} /> {showUpdateModal.addon?.branch}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">{t("modalUpdatePreviousCommit")}</span>
                  <span className="text-xs font-mono px-2 py-1 rounded bg-white/5 text-[var(--muted)]">
                    {showUpdateModal.result?.old_commit || showUpdateModal.result?.previous_commit || showUpdateModal.addon?.current_commit || "\u2014"}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--muted)]">{t("modalUpdateNewCommit")}</span>
                  <span className="text-xs font-mono px-2 py-1 rounded bg-white/5 text-[var(--muted)]">
                    {showUpdateModal.result?.new_commit || showUpdateModal.result?.commit || "\u2014"}
                  </span>
                </div>

                {showUpdateModal.result?.already_up_to_date && (
                  <div className="mt-2 p-3 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/20 flex items-center gap-2">
                    <CheckCircle size={14} className="text-[var(--success)]" />
                    <span className="text-sm text-[var(--success)]">{t("modalUpdateUpToDate")}</span>
                  </div>
                )}

                {showUpdateModal.addon?.url?.includes("github.com") && (() => {
                  const repoBase = showUpdateModal.addon.url.replace(/\.git$/, "");
                  const oldC = showUpdateModal.result?.old_commit || showUpdateModal.result?.previous_commit || showUpdateModal.addon?.current_commit;
                  const newC = showUpdateModal.result?.new_commit;
                  const href = oldC && newC && oldC !== newC
                    ? `${repoBase}/compare/${oldC}...${newC}`
                    : oldC
                    ? `${repoBase}/commit/${oldC}`
                    : `${repoBase}/commits/${showUpdateModal.addon.branch}`;
                  return (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline mt-1"
                    >
                      <Github size={14} /> {t("modalUpdateShowDiff")}
                    </a>
                  );
                })()}
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowUpdateModal(null)}
                  className="px-4 py-2 text-gray-400 hover:text-white text-sm"
                >
                  {showUpdateModal.result?.already_up_to_date ? t("close") : t("cancel")}
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
                        alert(e.message || t("modalFailedRestart"));
                      }
                    }}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm flex items-center gap-2"
                  >
                    <RefreshCw size={14} /> {t("modalUpdateModule")}
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
                <h3 className="text-lg font-semibold text-white">{t("modalDomainSettings")}</h3>
                <button onClick={() => setShowDomainModal(false)} className="text-gray-400 hover:text-white">&#x2715;</button>
              </div>

              {/* Primary Domain */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalDomainName")}</label>
                <input value={domainForm.domain} onChange={e => setDomainForm({...domainForm, domain: e.target.value})}
                  className="w-full px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white" placeholder="example.com" />
                <p className="text-xs text-gray-500 mt-1">
                  {t("modalDomainDnsHint")} <span className="text-amber-400 font-mono">{instance?.config?.endpoint || instance?.url?.replace(/https?:\/\//, "").split(":")[0]}</span>
                </p>
              </div>

              {/* Domain Aliases */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">{t("modalDomainAliases")}</label>
                {domainForm.aliases.map((alias, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input value={alias} onChange={e => { const a = [...domainForm.aliases]; a[i] = e.target.value; setDomainForm({...domainForm, aliases: a}); }}
                      className="flex-1 px-3 py-2 bg-black/30 border border-white/10 rounded-lg text-white text-sm" />
                    <button onClick={() => setDomainForm({...domainForm, aliases: domainForm.aliases.filter((_, j) => j !== i)})}
                      className="px-3 py-2 bg-red-500/20 text-red-400 rounded-lg text-sm hover:bg-red-500/30">{t("modalDomainRemoveAlias")}</button>
                  </div>
                ))}
                <button onClick={() => setDomainForm({...domainForm, aliases: [...domainForm.aliases, ""]})}
                  className="text-blue-400 text-sm hover:text-blue-300">{t("modalDomainAddAlias")}</button>
              </div>

              {/* HTTP Redirect Toggle */}
              <div className="flex items-center justify-between mb-6 py-3 border-t border-white/10">
                <span className="text-white text-sm">{t("modalDomainHttpRedirect")}</span>
                <button onClick={() => setDomainForm({...domainForm, http_redirect: !domainForm.http_redirect})}
                  className={`relative w-11 h-6 rounded-full transition-colors ${domainForm.http_redirect ? "bg-emerald-500" : "bg-gray-600"}`}>
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${domainForm.http_redirect ? "translate-x-5" : ""}`} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowDomainModal(false)} className="px-4 py-2 text-gray-400 hover:text-white">{tCommon("cancel")}</button>
                <button onClick={handleSaveDomain} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">{t("save")}</button>
              </div>
            </div>
          </div>
        )}
        {/* Backup Create Dialog */}
        {backupDialog && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setBackupDialog(null)}>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><Database size={18} /> {t("backupCreateTitle")}</h3>
              <p className="text-sm text-[var(--muted)] mb-4">{t("backupCreateDesc")}</p>
              <label className="flex items-center gap-3 p-3 rounded-lg bg-[var(--background)] border border-[var(--border)] cursor-pointer hover:bg-white/5 transition-colors">
                <input type="checkbox" checked={backupDialog.includeFilestore}
                  onChange={e => setBackupDialog({ ...backupDialog, includeFilestore: e.target.checked })}
                  className="w-4 h-4 rounded accent-[var(--accent)]" />
                <div>
                  <div className="text-sm font-medium">{t("backupIncludeFilestore")}</div>
                  <div className="text-xs text-[var(--muted)]">{t("backupIncludeFilestoreDesc")}</div>
                </div>
              </label>
              <div className="flex justify-end gap-3 mt-5">
                <button onClick={() => setBackupDialog(null)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-white transition-colors">{tCommon("cancel")}</button>
                <button onClick={confirmCreateBackup} className="px-4 py-2 text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 text-white rounded-lg transition-colors">{t("backupStart")}</button>
              </div>
            </div>
          </div>
        )}

        {/* Restore Dialog */}
        {restoreDialog && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setRestoreDialog(null)}>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-amber-400"><RotateCcw size={18} /> {t("restoreTitle")}</h3>
              <p className="text-sm text-[var(--muted)] mb-4">{t("restoreDesc")}</p>
              <label className={`flex items-center gap-3 p-3 rounded-lg bg-[var(--background)] border border-[var(--border)] transition-colors ${restoreDialog.hasFilestore ? "cursor-pointer hover:bg-white/5" : "opacity-50 cursor-not-allowed"}`}>
                <input type="checkbox" checked={restoreDialog.includeFilestore}
                  onChange={e => setRestoreDialog({ ...restoreDialog, includeFilestore: e.target.checked })}
                  disabled={!restoreDialog.hasFilestore}
                  className="w-4 h-4 rounded accent-[var(--accent)]" />
                <div>
                  <div className="text-sm font-medium">{t("restoreIncludeFilestore")}</div>
                  <div className="text-xs text-[var(--muted)]">
                    {restoreDialog.hasFilestore ? t("restoreIncludeFilestoreDesc") : t("restoreNoFilestore")}
                  </div>
                </div>
              </label>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mt-4">
                <p className="text-xs text-amber-400">{t("restoreWarning")}</p>
              </div>
              <div className="flex justify-end gap-3 mt-5">
                <button onClick={() => setRestoreDialog(null)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-white transition-colors">{tCommon("cancel")}</button>
                <button onClick={confirmRestore} className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors">{t("restoreConfirm")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  );
}
