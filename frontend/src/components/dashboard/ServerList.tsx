"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { serversApi, cloudApi } from "@/lib/api";
import {
  Server as ServerIcon, Cpu, MemoryStick, HardDrive, Trash2,
  RefreshCw, Plus, Wifi, WifiOff, CheckCircle2, XCircle,
  Loader2, Copy, Check, ArrowRight, ArrowLeft, Eye, EyeOff,
  Zap, Globe, Shield, CloudUpload, Link, Clock, Activity,
  Star, ChevronDown, ChevronUp, Tag, ShieldCheck, RotateCw, AlertTriangle,
  ShieldAlert, ShieldX, Scan, Bug, Skull, UserX, Terminal,
  Network, Key, Sparkles, Search, LayoutList, LayoutGrid,
} from "lucide-react";

interface ServerSpecs {
  cpu_cores: number;
  cpu_model: string;
  ram_mb: number;
  disk_gb: number;
  disk_used_gb: number;
  os: string;
  kernel: string;
  arch: string;
}

interface ServerData {
  id: string;
  name: string;
  server_type: string;
  provider: string;
  status: string;
  endpoint: string;
  region?: string;
  instances_count?: number;
  meta?: Record<string, any>;
  specs?: ServerSpecs | null;
  provider_plan?: string | null;
}

interface Metrics {
  cpu_percent?: number;
  ram_percent?: number;
  disk_percent?: number;
  pods?: number;
}

interface CloudProvider {
  id: string;
  name: string;
  available: boolean;
  currency: string;
}

interface CmsRecommendation {
  cms: string;
  label: string;
  level: "recommended" | "minimum" | "insufficient";
}

interface Plan {
  id: string;
  name: string;
  description?: string;
  label?: string;
  cores: number;
  memory_gb: number;
  memory_mb?: number;
  disk_gb: number;
  disk_type?: string;
  transfer_tb?: number;
  price_monthly: number;
  price_hourly: number;
  cpu_type?: string;
  plan_category?: string;
  plan_type?: string;
  type_class?: string;
  regions?: string[];
  cms_recommendations?: CmsRecommendation[];
}

interface Region {
  id: string;
  name: string;
  city?: string;
  country?: string;
  continent?: string;
  description?: string;
}

const statusColors: Record<string, string> = {
  online: "bg-[var(--success)]",
  offline: "bg-[var(--danger)]",
  provisioning: "bg-[var(--warning)]",
  scanning: "bg-[var(--warning)]",
  error: "bg-[var(--danger)]",
};

const providerLogos: Record<string, { label: string; color: string; short: string }> = {
  hetzner: { label: "Hetzner", color: "#d50c2d", short: "HZ" },
  digitalocean: { label: "DigitalOcean", color: "#0080ff", short: "DO" },
  vultr: { label: "Vultr", color: "#007bfc", short: "VT" },
  linode: { label: "Linode", color: "#00b050", short: "LN" },
  aws: { label: "AWS", color: "#ff9900", short: "AW" },
  azure: { label: "Azure", color: "#0078d4", short: "AZ" },
  gcp: { label: "GCP", color: "#4285f4", short: "GC" },
  custom: { label: "Custom", color: "#6b7280", short: "—" },
};

const currencySymbol: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

// ─── Server List (main) ─────────────────────────────────────────────

export function ServerList() {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const [servers, setServers] = useState<ServerData[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [loading, setLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<Record<string, any>>({});
  const [deleteDialog, setDeleteDialog] = useState<{ id: string; name: string; provider?: string; hasCloud: boolean } | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [searchQuery, setSearchQuery] = useState("");

  const loadServers = useCallback(async () => {
    try {
      const data = await serversApi.list();
      setServers(data);
      for (const s of data) {
        if (s.status === "online") {
          serversApi.metrics(s.id).then((m) => {
            setMetrics((prev) => ({ ...prev, [s.id]: m }));
          }).catch(() => {});
        }
      }
    } catch {
      // keep empty
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
    const interval = setInterval(loadServers, 30000);
    return () => clearInterval(interval);
  }, [loadServers]);

  const filteredServers = useMemo(() => {
    if (!searchQuery) return servers;
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.endpoint.toLowerCase().includes(q) ||
        s.provider?.toLowerCase().includes(q)
    );
  }, [servers, searchQuery]);

  function handleDeleteClick(server: ServerData) {
    const hasCloud = !!(server.meta?.provider_id && server.provider);
    setDeleteDialog({ id: server.id, name: server.name, provider: server.provider, hasCloud });
  }

  async function handleDeleteConfirm(destroyCloud: boolean) {
    if (!deleteDialog) return;
    try {
      await serversApi.remove(deleteDialog.id, destroyCloud);
      setServers((prev) => prev.filter((s) => s.id !== deleteDialog.id));
    } catch (err: any) {
      alert(err.message);
    }
    setDeleteDialog(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchServers")}
              className="pl-8 pr-3 py-2 bg-[var(--card)] border border-[var(--border)] rounded-lg text-sm w-44 focus:outline-none focus:border-[var(--accent)] focus:w-56 transition-all"
            />
          </div>
          {/* View toggle */}
          <div className="flex border border-[var(--border)] rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode("list")}
              className={`p-2 transition-colors ${viewMode === "list" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
            >
              <LayoutList size={16} />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`p-2 transition-colors ${viewMode === "grid" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
          <button
            onClick={loadServers}
            className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] transition-colors"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Plus size={16} /> {t("addServer")}
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <EmptyState onConnect={() => setShowWizard(true)} />
      ) : viewMode === "list" ? (
        /* ─── List View (table) ──────────────────────────────── */
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("server")}</th>
                <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("ip")}</th>
                <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("specs")}</th>
                <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{tc("status")}</th>
                <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("instances")}</th>
                <th className="text-right text-xs font-normal text-[var(--muted)] px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filteredServers.map((server) => {
                const prov = providerLogos[server.provider] || providerLogos.custom;
                return (
                  <tr key={server.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)] transition-colors">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-xs" style={{ backgroundColor: prov.color }}>
                          {prov.short}
                        </div>
                        <div>
                          <a href={`/servers/${server.id}`} className="text-sm font-medium hover:text-[var(--accent)] transition-colors">{server.name}</a>
                          <div className="text-xs text-[var(--muted)]">
                            {server.server_type === "kubernetes" ? "K8s" : "VM"} &middot; {prov.label}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm font-mono text-[var(--muted)]">{server.endpoint}</td>
                    <td className="px-5 py-4">
                      {server.specs ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-3 text-xs">
                            <span className="flex items-center gap-1 text-[var(--foreground)]">
                              <Cpu size={11} className="text-[var(--accent)]" />
                              {server.specs.cpu_cores} vCPU
                            </span>
                            <span className="flex items-center gap-1 text-[var(--foreground)]">
                              <MemoryStick size={11} className="text-[var(--accent)]" />
                              {server.specs.ram_mb >= 1024 ? `${(server.specs.ram_mb / 1024).toFixed(server.specs.ram_mb % 1024 === 0 ? 0 : 1)} GB` : `${server.specs.ram_mb} MB`}
                            </span>
                            <span className="flex items-center gap-1 text-[var(--foreground)]">
                              <HardDrive size={11} className="text-[var(--accent)]" />
                              {server.specs.disk_gb} GB
                            </span>
                          </div>
                          <div className="text-[10px] text-[var(--muted)] truncate max-w-[250px]">
                            {server.specs.os}{server.region ? ` · ${server.region}` : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">{server.region || "—"}</span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${statusColors[server.status] || "bg-[var(--muted)]"}`} />
                        <span className="text-sm capitalize">
                          {server.status === "online" ? t("connected") : server.status === "provisioning" ? t("provisioning") : server.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--muted)]">
                      {t("instanceCount", { count: server.instances_count || 0 })}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <button
                        onClick={() => handleDeleteClick(server)}
                        className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="text-right text-xs text-[var(--muted)] px-5 py-3 border-t border-[var(--border)]">
            {t("showingServers", { filtered: filteredServers.length, total: servers.length })}
          </div>
        </div>
      ) : (
        /* ─── Grid View (cards with resource bars) ───────────── */
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {filteredServers.map((server) => {
              const m = metrics[server.id];
              const prov = providerLogos[server.provider] || providerLogos.custom;
              const isExpanded = expandedServer === server.id;
              const sec = securityData[server.id];
              return (
                <div
                  key={server.id}
                  className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 transition-colors"
                >
                  {/* Header */}
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-xs" style={{ backgroundColor: prov.color }}>
                        {prov.short}
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm"><a href={`/servers/${server.id}`} className="hover:text-[var(--accent)] transition-colors">{server.name}</a></h3>
                        <div className="text-xs text-[var(--muted)]">
                          {server.server_type === "kubernetes" ? "K8s" : "VM"} &middot; {server.endpoint}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={`w-2.5 h-2.5 rounded-full ${statusColors[server.status] || "bg-[var(--muted)]"}`} />
                      <span className="text-xs font-medium">
                        {server.status === "online" ? t("connected") : server.status === "provisioning" ? t("provisioning") : server.status}
                      </span>
                      {server.status === "provisioning" && <Loader2 size={12} className="text-[var(--warning)] animate-spin" />}
                    </div>
                  </div>

                  {/* Hardware specs */}
                  {server.specs && (
                    <div className="flex flex-wrap gap-3 mb-3 text-xs">
                      <span className="flex items-center gap-1.5 bg-[var(--background)] px-2.5 py-1 rounded-md">
                        <Cpu size={12} className="text-[var(--accent)]" />
                        {server.specs.cpu_cores} vCPU
                      </span>
                      <span className="flex items-center gap-1.5 bg-[var(--background)] px-2.5 py-1 rounded-md">
                        <MemoryStick size={12} className="text-[var(--accent)]" />
                        {server.specs.ram_mb >= 1024 ? `${(server.specs.ram_mb / 1024).toFixed(server.specs.ram_mb % 1024 === 0 ? 0 : 1)} GB` : `${server.specs.ram_mb} MB`}
                      </span>
                      <span className="flex items-center gap-1.5 bg-[var(--background)] px-2.5 py-1 rounded-md">
                        <HardDrive size={12} className="text-[var(--accent)]" />
                        {server.specs.disk_gb} GB
                      </span>
                      {server.specs.os && (
                        <span className="flex items-center gap-1.5 bg-[var(--background)] px-2.5 py-1 rounded-md text-[var(--muted)]">
                          {server.specs.os}
                        </span>
                      )}
                      {server.region && (
                        <span className="flex items-center gap-1.5 bg-[var(--background)] px-2.5 py-1 rounded-md text-[var(--muted)]">
                          <Globe size={12} />
                          {server.region}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Resource bars */}
                  {server.status === "online" && m && (
                    <div className="space-y-2.5 mb-4">
                      <ResourceBar label="CPU" value={m.cpu_percent} />
                      <ResourceBar label="Memory" value={m.ram_percent} />
                      <ResourceBar label="Disk" value={m.disk_percent} />
                    </div>
                  )}

                  {server.status === "provisioning" && (
                    <div className="mb-4 text-xs text-[var(--warning)] flex items-center gap-2">
                      <Loader2 size={12} className="animate-spin" />
                      {t("settingUpEnvironment")}
                    </div>
                  )}

                  {/* Timestamp + refresh */}
                  {server.status === "online" && (
                    <div className="text-right mb-3">
                      <span className="text-[10px] text-[var(--muted)]">
                        {new Date().toLocaleString()} <RefreshCw size={10} className="inline ml-1 cursor-pointer hover:text-[var(--accent)]" onClick={loadServers} />
                      </span>
                    </div>
                  )}

                  {/* Footer: instances count + security + actions */}
                  <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
                    <span className="text-xs text-[var(--muted)]">
                      {t("instanceCount", { count: server.instances_count || 0 })}
                    </span>
                    <div className="flex items-center gap-2">
                      {server.status === "online" && (
                        <button
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedServer(null);
                            } else {
                              setExpandedServer(server.id);
                              if (!sec) {
                                serversApi.security(server.id).then((d) => {
                                  setSecurityData((prev) => ({ ...prev, [server.id]: d }));
                                }).catch(() => {});
                              }
                            }
                          }}
                          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full transition-colors hover:bg-[var(--border)]"
                          title={t("securityAudit")}
                        >
                          <ShieldCheck size={12} className={sec?.security_score >= 80 ? "text-[var(--success)]" : sec?.security_score >= 50 ? "text-[var(--warning)]" : "text-[var(--muted)]"} />
                          {sec && <span className={sec.security_score >= 80 ? "text-[var(--success)]" : sec.security_score >= 50 ? "text-[var(--warning)]" : "text-[var(--danger)]"}>{sec.security_score}</span>}
                          {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        </button>
                      )}
                      <a
                        href={`/servers/${server.id}`}
                        className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
                      >
                        Manage <ArrowRight size={10} />
                      </a>
                      <button
                        onClick={() => handleDeleteClick(server)}
                        className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded security panel */}
                  {isExpanded && sec && (
                    <SecurityPanel server={server} data={sec} onReboot={() => {
                      if (confirm(t("confirmReboot", { name: server.name }))) {
                        serversApi.reboot(server.id).then(() => {
                          alert(t("rebootScheduled"));
                        }).catch((e: any) => alert(e.message));
                      }
                    }} />
                  )}
                  {isExpanded && !sec && (
                    <div className="mt-4 flex items-center justify-center py-4">
                      <Loader2 size={16} className="animate-spin text-[var(--accent)]" />
                      <span className="ml-2 text-xs text-[var(--muted)]">{t("runningSecurityAudit")}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="text-right text-xs text-[var(--muted)] mt-4">
            {t("showingServers", { filtered: filteredServers.length, total: servers.length })}
          </div>
        </>
      )}

      {showWizard && (
        <ConnectServerWizard
          onClose={() => setShowWizard(false)}
          onConnected={() => { setShowWizard(false); loadServers(); }}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleteDialog && (
        <DeleteServerDialog
          name={deleteDialog.name}
          provider={deleteDialog.provider}
          hasCloud={deleteDialog.hasCloud}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────

function DeleteServerDialog({ name, provider, hasCloud, onConfirm, onCancel }: {
  name: string; provider?: string; hasCloud: boolean;
  onConfirm: (destroyCloud: boolean) => void; onCancel: () => void;
}) {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const [destroyCloud, setDestroyCloud] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const providerLabel = provider ? (providerLogos[provider]?.label || provider) : "";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        className="bg-[var(--card)] border border-[var(--border)] rounded-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[var(--danger)]/10 flex items-center justify-center">
            <Trash2 size={20} className="text-[var(--danger)]" />
          </div>
          <div>
            <h3 className="font-semibold">{t("deleteTitle")}</h3>
            <p className="text-sm text-[var(--muted)]">{name}</p>
          </div>
        </div>

        <p className="text-sm text-[var(--muted)] mb-4">
          {t("deleteDescription")}
        </p>

        {hasCloud && (
          <label className="flex items-start gap-3 p-3 rounded-lg bg-[var(--danger)]/5 border border-[var(--danger)]/20 cursor-pointer mb-4">
            <input
              type="checkbox"
              checked={destroyCloud}
              onChange={(e) => setDestroyCloud(e.target.checked)}
              className="mt-0.5 accent-[var(--danger)]"
            />
            <div>
              <span className="text-sm font-medium text-[var(--danger)]">
                {t("destroyOnProvider", { provider: providerLabel })}
              </span>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                {t("destroyDescription", { provider: providerLabel })}
              </p>
            </div>
          </label>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
          >
            {tc("cancel")}
          </button>
          <button
            onClick={async () => { setDeleting(true); await onConfirm(destroyCloud); }}
            disabled={deleting}
            className="px-4 py-2 text-sm font-medium bg-[var(--danger)] hover:bg-[var(--danger)]/80 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {destroyCloud ? t("removeAndDestroy") : tc("remove")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────

function EmptyState({ onConnect }: { onConnect: () => void }) {
  const t = useTranslations("servers");
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
      <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center">
        <ServerIcon size={32} className="text-[var(--accent)]" />
      </div>
      <h3 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h3>
      <p className="text-sm text-[var(--muted)] mb-6 max-w-md mx-auto">
        {t("emptyDescription")}
      </p>
      <div className="flex gap-8 justify-center mb-8 text-sm text-[var(--muted)]">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-[var(--accent)]" />
          {t("autoSetup")}
        </div>
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-[var(--accent)]" />
          {t("sshKeyAuth")}
        </div>
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-[var(--accent)]" />
          {t("multiProvider")}
        </div>
      </div>
      <button
        onClick={onConnect}
        className="px-6 py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors"
      >
        {t("addServer")}
      </button>
    </div>
  );
}

// ─── Metric Bar (legacy, used by other components) ──────────────────

function MetricBar({ label, value, icon: Icon }: { label: string; value?: number; icon: any }) {
  const v = value ?? 0;
  const color = v > 90 ? "bg-[var(--danger)]" : v > 70 ? "bg-[var(--warning)]" : "bg-[var(--accent)]";
  return (
    <div className="flex-1">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-[var(--muted)] flex items-center gap-1"><Icon size={12} /> {label}</span>
        <span>{v}%</span>
      </div>
      <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

// ─── Resource Bar (CloudPepper-style stacked bar) ───────────────────

function ResourceBar({ label, value }: { label: string; value?: number }) {
  const v = value ?? 0;
  // Green for used, orange for warning zone, remaining is empty
  const isWarning = v > 70;
  const isCritical = v > 90;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-semibold w-16">{label}</span>
      <div className="flex-1 h-4 bg-[var(--border)] rounded overflow-hidden flex">
        <div
          className={`h-full transition-all ${isCritical ? "bg-red-500" : isWarning ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${Math.min(v, 100)}%` }}
        />
      </div>
      <span className="text-xs text-[var(--muted)] w-10 text-right">{v}%</span>
    </div>
  );
}

// ─── Security Panel ──────────────────────────────────────────────

function SecurityPanel({ server, data, onReboot }: { server: ServerData; data: any; onReboot: () => void }) {
  const t = useTranslations("servers");
  const tc = useTranslations("common");
  const scoreColor = data.security_score >= 80 ? "text-[var(--success)]" : data.security_score >= 50 ? "text-[var(--warning)]" : "text-[var(--danger)]";
  const scoreLabel = data.security_score >= 80 ? t("security.excellent") : data.security_score >= 50 ? t("security.fair") : t("security.needsAttention");

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className={scoreColor} />
          <span className="text-sm font-medium">{t("security.score")}: <span className={scoreColor}>{data.security_score}/100</span></span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--muted)]">{scoreLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          {data.reboot_required && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)] flex items-center gap-1">
              <AlertTriangle size={10} /> {t("rebootRequired")}
            </span>
          )}
          <button
            onClick={onReboot}
            className="text-xs px-2.5 py-1 rounded-lg bg-[var(--background)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)]/50 transition-colors flex items-center gap-1"
          >
            <RotateCw size={11} /> {t("reboot")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SecurityItem
          label={t("security.firewall")}
          active={data.firewall?.enabled}
          detail={data.firewall?.enabled ? t("security.ufwActive") : t("security.notConfigured")}
        />
        <SecurityItem
          label={t("security.fail2ban")}
          active={data.fail2ban?.active}
          detail={data.fail2ban?.active ? t("security.banned", { count: data.fail2ban.banned_ips }) : tc("inactive")}
        />
        <SecurityItem
          label={t("security.sshHardened")}
          active={data.ssh?.password_auth_disabled}
          detail={data.ssh?.password_auth_disabled ? t("security.keyOnlyAuth") : t("security.passwordEnabled")}
        />
        <SecurityItem
          label={t("security.autoUpdates")}
          active={data.auto_updates?.active}
          detail={data.auto_updates?.active ? t("security.securityPatches") : tc("disabled")}
        />
      </div>

      {data.system && (
        <div className="mt-3 flex gap-4 text-[10px] text-[var(--muted)]">
          {data.system.os && <span>OS: {data.system.os}</span>}
          {data.system.kernel && <span>Kernel: {data.system.kernel}</span>}
          {data.system.uptime && <span>Uptime: {data.system.uptime}</span>}
          {data.docker?.version && <span>{data.docker.version}</span>}
          {data.swap_mb > 0 && <span>Swap: {data.swap_mb} MB</span>}
          {data.pending_updates > 0 && (
            <span className="text-[var(--warning)]">{t("security.pendingUpdates", { count: data.pending_updates })}</span>
          )}
        </div>
      )}
    </div>
  );
}

function SecurityItem({ label, active, detail }: { label: string; active?: boolean; detail: string }) {
  return (
    <div className={`px-3 py-2 rounded-lg border text-xs ${
      active
        ? "bg-[var(--success)]/5 border-[var(--success)]/20"
        : "bg-[var(--danger)]/5 border-[var(--danger)]/20"
    }`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        {active ? (
          <CheckCircle2 size={11} className="text-[var(--success)]" />
        ) : (
          <XCircle size={11} className="text-[var(--danger)]" />
        )}
        <span className="font-medium">{label}</span>
      </div>
      <span className="text-[var(--muted)]">{detail}</span>
    </div>
  );
}

// ─── Server Wizard ───────────────────────────────────────────────────

type WizardMode = "choose" | "create" | "connect";
type ConnectStep = "info" | "connect" | "precheck" | "done";
type CreateStep = "provider" | "plan" | "confirm" | "done";

const manualProviders = [
  { id: "hetzner", name: "Hetzner" },
  { id: "digitalocean", name: "DigitalOcean" },
  { id: "vultr", name: "Vultr" },
  { id: "linode", name: "Linode" },
  { id: "aws", name: "AWS" },
  { id: "azure", name: "Azure" },
  { id: "gcp", name: "Google Cloud" },
  { id: "custom", name: "Other" },
];

function ConnectServerWizard({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const t = useTranslations("wizard");
  const [mode, setMode] = useState<WizardMode>("choose");

  // Connect existing state
  const [connectStep, setConnectStep] = useState<ConnectStep>("info");
  const [form, setForm] = useState({
    name: "", provider: "hetzner", endpoint: "", ssh_user: "root", password: "", usePassword: true,
  });
  const [publicKey, setPublicKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; hostname: string; error: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectedServer, setConnectedServer] = useState<any>(null);
  // Precheck state
  const [scanning, setScanning] = useState(false);
  const [precheckResult, setPrecheckResult] = useState<any>(null);
  const [sanitizing, setSanitizing] = useState(false);
  const [sanitizeResult, setSanitizeResult] = useState<any>(null);

  // Create new state
  const [createStep, setCreateStep] = useState<CreateStep>("provider");
  const [availableProviders, setAvailableProviders] = useState<CloudProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", plan: "", region: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdServer, setCreatedServer] = useState<any>(null);
  const [cmsFilter, setCmsFilter] = useState<string>(""); // odoo-18, wordpress, etc.
  const [workloadFilter, setWorkloadFilter] = useState<string>("startup"); // startup, medium, intensive

  // Load SSH key and check providers
  useEffect(() => {
    serversApi.sshKey().then((r) => setPublicKey(r.public_key)).catch(() => {});
    cloudApi.providers().then((prov) => setAvailableProviders(prov)).catch(() => {});
  }, []);

  // Load plans+regions when provider selected
  useEffect(() => {
    if (!selectedProvider) return;
    setPlansLoading(true);
    setPlans([]);
    setRegions([]);
    setCreateForm((f) => ({ ...f, plan: "", region: "" }));
    Promise.all([
      cloudApi.plans(selectedProvider),
      cloudApi.regions(selectedProvider),
    ])
      .then(([p, r]) => {
        setPlans(p);
        setRegions(r);
        // Auto-select first region
        if (r.length > 0) {
          setCreateForm((f) => ({ ...f, region: r[0].id || r[0].name }));
        }
      })
      .catch(() => setCreateError(t("failedLoadPlans")))
      .finally(() => setPlansLoading(false));
  }, [selectedProvider, t]);

  function handleCopy() {
    navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleTestConnection() {
    setTesting(true); setTestResult(null);
    try {
      const result = await serversApi.testConnection({
        endpoint: form.endpoint, ssh_user: form.ssh_user,
        password: form.usePassword ? form.password : undefined,
      });
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ connected: false, hostname: "", error: err.message });
    } finally { setTesting(false); }
  }

  async function handleConnect() {
    // Run security pre-check before actual connection
    setScanning(true); setPrecheckResult(null); setSanitizeResult(null); setConnectError("");
    try {
      const result = await serversApi.precheck({
        endpoint: form.endpoint,
        ssh_user: form.ssh_user,
        password: form.usePassword ? form.password : undefined,
      });
      setPrecheckResult(result);
      setConnectStep("precheck");
    } catch (err: any) { setConnectError(err.message); }
    finally { setScanning(false); }
  }

  async function handleSanitize() {
    setSanitizing(true);
    try {
      const result = await serversApi.sanitize({
        endpoint: form.endpoint,
        ssh_user: form.ssh_user,
        password: form.usePassword ? form.password : undefined,
        threats: precheckResult?.threats || [],
      });
      setSanitizeResult(result);
      // After sanitization, re-run precheck to verify
      const recheck = await serversApi.precheck({
        endpoint: form.endpoint,
        ssh_user: form.ssh_user,
        password: form.usePassword ? form.password : undefined,
      });
      setPrecheckResult(recheck);
    } catch (err: any) { setConnectError(err.message); }
    finally { setSanitizing(false); }
  }

  async function handleProceedConnect() {
    setConnecting(true); setConnectError("");
    try {
      const server = await serversApi.connect({
        name: form.name, provider: form.provider, endpoint: form.endpoint,
        ssh_user: form.ssh_user, password: form.usePassword ? form.password : undefined,
      });
      setConnectedServer(server);
      setConnectStep("done");
    } catch (err: any) { setConnectError(err.message); }
    finally { setConnecting(false); }
  }

  async function handleCreate() {
    setCreating(true); setCreateError("");
    try {
      const result = await cloudApi.create(selectedProvider, createForm);
      setCreatedServer(result);
      setCreateStep("done");
    } catch (err: any) { setCreateError(err.message); }
    finally { setCreating(false); }
  }

  const providerInfo = availableProviders.find((p) => p.id === selectedProvider);
  const sym = currencySymbol[providerInfo?.currency || "USD"] || "$";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        className={`bg-[var(--card)] border border-[var(--border)] rounded-2xl w-full overflow-hidden max-h-[90vh] flex flex-col ${
          mode === "create" && createStep === "plan" ? "max-w-5xl" : "max-w-3xl"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold">
              {mode === "choose" ? t("addServer") :
               mode === "create" ? (createStep === "provider" ? t("chooseProvider") : t("createServer", { provider: providerInfo?.name || "" })) :
               connectStep === "precheck" ? t("securityScan") : t("connectExisting")}
            </h2>
            <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--foreground)] text-xl leading-none">&times;</button>
          </div>
          {mode === "create" && createStep !== "provider" && (
            <p className="text-xs text-[var(--muted)]">
              {t("serverAutoConfig", { provider: providerInfo?.name || "" })}
            </p>
          )}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
          {/* Choose mode */}
          {mode === "choose" && (
            <ChooseMode
              hasProviders={availableProviders.some((p) => p.available)}
              onChooseCreate={() => setMode("create")}
              onChooseConnect={() => setMode("connect")}
            />
          )}

          {/* Create flow */}
          {mode === "create" && createStep === "provider" && (
            <ChooseProvider
              providers={availableProviders}
              selected={selectedProvider}
              onSelect={(id) => { setSelectedProvider(id); setCreateStep("plan"); }}
              onBack={() => setMode("choose")}
            />
          )}
          {mode === "create" && createStep === "plan" && (
            <CreatePlanStep
              plans={plans} regions={regions} loading={plansLoading}
              form={createForm} setForm={setCreateForm}
              sym={sym} provider={selectedProvider}
              cmsFilter={cmsFilter} setCmsFilter={setCmsFilter}
              workloadFilter={workloadFilter} setWorkloadFilter={setWorkloadFilter}
              onNext={() => setCreateStep("confirm")}
              onBack={() => { setCreateStep("provider"); setSelectedProvider(""); }}
              error={createError}
            />
          )}
          {mode === "create" && createStep === "confirm" && (
            <CreateConfirmStep
              form={createForm} plans={plans} regions={regions}
              provider={selectedProvider} providerName={providerInfo?.name || ""}
              sym={sym} creating={creating} error={createError}
              onCreate={handleCreate}
              onBack={() => setCreateStep("plan")}
            />
          )}
          {mode === "create" && createStep === "done" && (
            <StepDone server={createdServer} onFinish={onConnected} isCreate />
          )}

          {/* Connect existing flow */}
          {mode === "connect" && connectStep === "info" && (
            <StepInfo
              form={form} setForm={setForm} providers={manualProviders}
              canProceed={!!(form.name.trim() && form.endpoint.trim())}
              onNext={() => setConnectStep("connect")}
              onBack={() => setMode("choose")}
            />
          )}
          {mode === "connect" && connectStep === "connect" && (
            <StepConnect
              form={form} setForm={setForm}
              publicKey={publicKey} copied={copied} onCopy={handleCopy}
              showPassword={showPassword} setShowPassword={setShowPassword}
              testing={testing} testResult={testResult} onTest={handleTestConnection}
              connecting={connecting} connectError={connectError}
              onConnect={handleConnect}
              onBack={() => { setConnectStep("info"); setTestResult(null); }}
            />
          )}
          {mode === "connect" && connectStep === "precheck" && (
            <StepPrecheck
              precheckResult={precheckResult}
              sanitizeResult={sanitizeResult}
              sanitizing={sanitizing}
              connecting={connecting}
              connectError={connectError}
              onSanitize={handleSanitize}
              onProceed={handleProceedConnect}
              onBack={() => { setConnectStep("connect"); setPrecheckResult(null); setSanitizeResult(null); }}
            />
          )}
          {mode === "connect" && connectStep === "done" && (
            <StepDone server={connectedServer} onFinish={onConnected} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Choose Mode ─────────────────────────────────────────────────────

function ChooseMode({ hasProviders, onChooseCreate, onChooseConnect }: {
  hasProviders: boolean; onChooseCreate: () => void; onChooseConnect: () => void;
}) {
  const t = useTranslations("wizard");
  return (
    <div className="grid grid-cols-2 gap-4">
      <button
        onClick={onChooseCreate}
        disabled={!hasProviders}
        className="group bg-[var(--background)] border border-[var(--border)] rounded-xl p-6 text-left hover:border-[var(--accent)]/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <div className="w-12 h-12 rounded-xl bg-[var(--accent)]/10 flex items-center justify-center mb-4 group-hover:bg-[var(--accent)]/20 transition-colors">
          <CloudUpload size={24} className="text-[var(--accent)]" />
        </div>
        <h3 className="font-semibold mb-1">{t("createNewServer")}</h3>
        <p className="text-xs text-[var(--muted)] mb-3">
          {t("createDescription")}
        </p>
        <span className="text-xs text-[var(--accent)] font-medium">
          {hasProviders ? t("hourlyBilling") : t("configureApiFirst")}
        </span>
      </button>

      <button
        onClick={onChooseConnect}
        className="group bg-[var(--background)] border border-[var(--border)] rounded-xl p-6 text-left hover:border-[var(--accent)]/50 transition-all"
      >
        <div className="w-12 h-12 rounded-xl bg-[var(--success)]/10 flex items-center justify-center mb-4 group-hover:bg-[var(--success)]/20 transition-colors">
          <Link size={24} className="text-[var(--success)]" />
        </div>
        <h3 className="font-semibold mb-1">{t("connectExistingServer")}</h3>
        <p className="text-xs text-[var(--muted)] mb-3">
          {t("connectDescription")}
        </p>
        <span className="text-xs text-[var(--success)] font-medium">{t("anyProvider")}</span>
      </button>
    </div>
  );
}

// ─── Choose Provider ─────────────────────────────────────────────────

function ChooseProvider({ providers, selected, onSelect, onBack }: {
  providers: CloudProvider[]; selected: string; onSelect: (id: string) => void; onBack: () => void;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  const ts = useTranslations("servers");
  const available = providers.filter((p) => p.available);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        {providers.map((p) => {
          const logo = providerLogos[p.id] || providerLogos.custom;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              disabled={!p.available}
              className={`group flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                p.available
                  ? "bg-[var(--background)] border-[var(--border)] hover:border-[var(--accent)]/50"
                  : "bg-[var(--background)]/50 border-[var(--border)]/50 opacity-50 cursor-not-allowed"
              }`}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
                style={{ backgroundColor: logo.color }}
              >
                {logo.short}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-xs text-[var(--muted)]">
                  {p.available ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 size={10} className="text-[var(--success)]" /> {ts("connected")}
                    </span>
                  ) : (
                    t("apiNotConfigured")
                  )}
                </div>
              </div>
              {p.available && (
                <ArrowRight size={14} className="text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex justify-between pt-2">
        <button onClick={onBack} className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
          <ArrowLeft size={14} /> {tc("back")}
        </button>
      </div>
    </div>
  );
}

// ─── Create: Plan Selection (Smart Guided) ──────────────────────────

const CMS_OPTIONS = [
  { id: "odoo", label: "Odoo", icon: "OD" },
  { id: "wordpress", label: "WordPress", icon: "WP" },
  { id: "woocommerce", label: "WooCommerce", icon: "WC" },
  { id: "prestashop", label: "PrestaShop", icon: "PS" },
  { id: "magento", label: "Magento 2", icon: "MG" },
];

const WORKLOAD_OPTIONS = [
  { id: "startup", label: "Startup", desc: "Small projects, few users, dev/test", icon: Zap },
  { id: "medium", label: "Production", desc: "Moderate traffic, 50-200 users", icon: Activity },
  { id: "intensive", label: "High Traffic", desc: "Large catalogs, heavy workload", icon: ServerIcon },
];

function CreatePlanStep({ plans, regions, loading, form, setForm, sym, provider,
  cmsFilter, setCmsFilter, workloadFilter, setWorkloadFilter, onNext, onBack, error }: {
  plans: Plan[]; regions: Region[]; loading: boolean;
  form: any; setForm: (f: any) => void; sym: string; provider: string;
  cmsFilter: string; setCmsFilter: (f: string) => void;
  workloadFilter: string; setWorkloadFilter: (f: string) => void;
  onNext: () => void; onBack: () => void; error: string;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  // Filter and sort plans based on CMS + workload
  const { perfectPlans, goodPlans } = useMemo(() => {
    if (!cmsFilter) return { perfectPlans: plans, goodPlans: [] as Plan[] };

    const perfect: Plan[] = [];
    const good: Plan[] = [];

    for (const plan of plans) {
      const fit = (plan as any).workload_fit?.[cmsFilter]?.[workloadFilter];
      if (!fit) continue;
      if (fit.fit === "perfect") perfect.push(plan);
      else if (fit.fit === "good") good.push(plan);
    }

    // Sort by price ascending
    perfect.sort((a, b) => a.price_monthly - b.price_monthly);
    good.sort((a, b) => a.price_monthly - b.price_monthly);

    return { perfectPlans: perfect, goodPlans: good };
  }, [plans, cmsFilter, workloadFilter]);

  // Filter regions for selected plan
  const availableRegions = useMemo(() => {
    const selectedPlan = plans.find((p) => p.name === form.plan || p.id === form.plan);
    if (!selectedPlan?.regions || selectedPlan.regions.length === 0) return regions;
    return regions.filter((r) => selectedPlan.regions!.includes(r.id || r.name));
  }, [plans, regions, form.plan]);

  const hasResults = perfectPlans.length > 0 || goodPlans.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
        <span className="ml-3 text-sm text-[var(--muted)]">{t("loadingPlans")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-4 py-3">{error}</div>
        <button onClick={onBack} className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
          <ArrowLeft size={14} /> {tc("back")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-0">
      {/* Left column — Configuration */}
      <div className="lg:w-[340px] shrink-0 space-y-4">
        {/* Server Name */}
        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t("serverName")}</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("serverNamePlaceholder")}
            className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            autoFocus
          />
        </div>

        {/* CMS Selection */}
        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1.5">{t("whatToInstall")}</label>
          <div className="grid grid-cols-3 lg:grid-cols-2 gap-1.5">
            {CMS_OPTIONS.map((cms) => (
              <button
                key={cms.id}
                type="button"
                onClick={() => { setCmsFilter(cms.id); setForm({ ...form, plan: "" }); }}
                className={`px-2.5 py-2 rounded-lg text-left transition-all ${
                  cmsFilter === cms.id
                    ? "bg-[var(--accent)]/10 border-2 border-[var(--accent)]"
                    : "bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent)]/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-7 h-7 rounded-md flex items-center justify-center text-[9px] font-bold shrink-0 ${
                    cmsFilter === cms.id ? "bg-[var(--accent)] text-white" : "bg-[var(--border)] text-[var(--muted)]"
                  }`}>
                    {cms.icon}
                  </span>
                  <span className={`text-xs font-medium ${cmsFilter === cms.id ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                    {cms.label}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Workload Selection */}
        {cmsFilter && (
          <div>
            <label className="block text-xs font-medium text-[var(--muted)] mb-1.5">{t("expectedWorkload")}</label>
            <div className="flex gap-1.5">
              {WORKLOAD_OPTIONS.map((wl) => {
                const Icon = wl.icon;
                return (
                  <button
                    key={wl.id}
                    type="button"
                    onClick={() => { setWorkloadFilter(wl.id); setForm({ ...form, plan: "" }); }}
                    className={`flex-1 px-2 py-2 rounded-lg text-center transition-all ${
                      workloadFilter === wl.id
                        ? "bg-[var(--accent)]/10 border-2 border-[var(--accent)]"
                        : "bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent)]/30"
                    }`}
                  >
                    <Icon size={13} className={`mx-auto mb-0.5 ${workloadFilter === wl.id ? "text-[var(--accent)]" : "text-[var(--muted)]"}`} />
                    <span className={`text-[11px] font-semibold block ${workloadFilter === wl.id ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                      {t(wl.id === "startup" ? "startup" : wl.id === "medium" ? "production" : "highTraffic")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Region */}
        {cmsFilter && (
          <div>
            <label className="block text-xs font-medium text-[var(--muted)] mb-1.5">{t("region")}</label>
            <div className="flex gap-1.5 flex-wrap">
              {availableRegions.slice(0, 12).map((r) => (
                <button
                  key={r.id || r.name}
                  type="button"
                  onClick={() => setForm({ ...form, region: r.name || String(r.id) })}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    form.region === (r.name || String(r.id))
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--background)] border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50"
                  }`}
                >
                  {r.city || r.name}{r.country ? ` (${r.country})` : ""}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-1">
          <button onClick={onBack} className="px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
            <ArrowLeft size={14} /> {tc("back")}
          </button>
          <button
            onClick={onNext}
            disabled={!form.name.trim() || !form.plan || !form.region}
            className="px-5 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            {tc("review")} <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Right column — Plans */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {cmsFilter ? (
          <>
            <label className="block text-xs font-medium text-[var(--muted)] mb-2">
              {hasResults ? t("recommendedPlans", { count: perfectPlans.length + goodPlans.length }) : t("noPlansAvailable")}
            </label>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
              {/* Perfect fit */}
              {perfectPlans.map((plan, i) => (
                <PlanCard
                  key={plan.id || plan.name}
                  plan={plan}
                  selected={form.plan === (plan.name || plan.id)}
                  sym={sym}
                  fitLevel="perfect"
                  isBestValue={i === 0}
                  onClick={() => setForm({ ...form, plan: plan.name || plan.id })}
                />
              ))}

              {/* Good fit (separator) */}
              {goodPlans.length > 0 && perfectPlans.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-[var(--border)]" />
                  <span className="text-[10px] text-[var(--muted)]">{t("alsoCompatible")}</span>
                  <div className="flex-1 h-px bg-[var(--border)]" />
                </div>
              )}
              {goodPlans.map((plan) => (
                <PlanCard
                  key={plan.id || plan.name}
                  plan={plan}
                  selected={form.plan === (plan.name || plan.id)}
                  sym={sym}
                  fitLevel="good"
                  onClick={() => setForm({ ...form, plan: plan.name || plan.id })}
                />
              ))}

              {!hasResults && cmsFilter && (
                <div className="text-center py-8 text-sm text-[var(--muted)]">
                  {t("noPlansCombination")}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--muted)]">
            {t("selectCmsForPlans")}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Plan Card ───────────────────────────────────────────────────────

function PlanCard({ plan, selected, sym, fitLevel, isBestValue, onClick }: {
  plan: Plan; selected: boolean; sym: string; fitLevel: "perfect" | "good";
  isBestValue?: boolean; onClick: () => void;
}) {
  const t = useTranslations("wizard");
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-3 rounded-xl transition-all relative ${
        selected
          ? "bg-[var(--accent)]/10 border-2 border-[var(--accent)] shadow-sm"
          : fitLevel === "perfect"
            ? "bg-[var(--background)] border border-[var(--success)]/20 hover:border-[var(--accent)]/50"
            : "bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent)]/30"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* Fit indicator */}
          <div className={`w-2 h-2 rounded-full shrink-0 ${
            fitLevel === "perfect" ? "bg-[var(--success)]" : "bg-[var(--warning)]"
          }`} />

          {/* Plan name */}
          <span className="font-mono font-bold text-sm w-[80px] shrink-0">{plan.name}</span>

          {/* CPU type badge */}
          {(() => {
            const name = plan.name || "";
            if (name.startsWith("ccx")) return (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium shrink-0">{t("dedicated")}</span>
            );
            if (name.startsWith("cpx")) return (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium shrink-0">{t("performance")}</span>
            );
            if (name.startsWith("cx")) return (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400 font-medium shrink-0">{t("costOptimized")}</span>
            );
            if ((plan as any).plan_category) return (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/10 text-slate-400 font-medium shrink-0">{(plan as any).plan_category}</span>
            );
            return null;
          })()}

          {/* Specs */}
          <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
            <span className="flex items-center gap-1">
              <Cpu size={11} /> {plan.cores} vCPU{plan.cores > 1 ? "s" : ""}
            </span>
            <span className="flex items-center gap-1">
              <MemoryStick size={11} /> {plan.memory_gb} GB
            </span>
            <span className="flex items-center gap-1">
              <HardDrive size={11} /> {plan.disk_gb} GB {plan.disk_type || "NVMe"}
            </span>
            {plan.transfer_tb ? (
              <span className="flex items-center gap-1">
                <Activity size={11} /> {plan.transfer_tb} TB
              </span>
            ) : null}
          </div>
        </div>

        {/* Price + Best Value */}
        <div className="text-right shrink-0 ml-3 flex items-center gap-2">
          {isBestValue && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500 text-white font-bold tracking-wide whitespace-nowrap">
              {t("bestValue")}
            </span>
          )}
          <div>
            <div className="text-sm font-bold text-[var(--accent)]">
              {sym}{plan.price_monthly.toFixed(2)}<span className="text-[10px] font-normal text-[var(--muted)]">/mo</span>
            </div>
            {plan.price_hourly > 0 && (
              <div className="text-[10px] text-[var(--muted)] flex items-center justify-end gap-0.5">
                <Clock size={9} /> {sym}{plan.price_hourly.toFixed(4)}/h
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Create: Confirm ─────────────────────────────────────────────────

function CreateConfirmStep({ form, plans, regions, provider, providerName, sym, creating, error, onCreate, onBack }: {
  form: any; plans: Plan[]; regions: Region[]; provider: string; providerName: string;
  sym: string; creating: boolean; error: string; onCreate: () => void; onBack: () => void;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  const ts = useTranslations("servers");
  const plan = plans.find((p) => p.name === form.plan || p.id === form.plan);
  const region = regions.find((r) => (r.name || String(r.id)) === form.region);

  return (
    <div className="space-y-5">
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-5">
        <h3 className="font-semibold mb-4">{t("reviewConfig")}</h3>
        <div className="grid grid-cols-2 gap-y-3 text-sm">
          <span className="text-[var(--muted)]">{tc("provider")}</span>
          <span className="font-medium flex items-center gap-2">
            <span className="w-5 h-5 rounded text-[9px] font-bold text-white flex items-center justify-center"
              style={{ backgroundColor: providerLogos[provider]?.color || "#666" }}>
              {providerLogos[provider]?.short || "?"}
            </span>
            {providerName}
          </span>
          <span className="text-[var(--muted)]">{tc("name")}</span>
          <span className="font-medium">{form.name}</span>
          <span className="text-[var(--muted)]">{t("plan")}</span>
          <span className="font-mono font-medium">{form.plan}</span>
          <span className="text-[var(--muted)]">{ts("specs")}</span>
          <span>{plan?.cores} vCPU, {plan?.memory_gb} GB RAM, {plan?.disk_gb} GB {plan?.disk_type || "SSD"}</span>
          {plan?.transfer_tb ? (
            <>
              <span className="text-[var(--muted)]">{t("transfer")}</span>
              <span>{plan.transfer_tb} TB/month</span>
            </>
          ) : null}
          <span className="text-[var(--muted)]">{t("location")}</span>
          <span>{region?.city || form.region}{region?.country ? ` (${region.country})` : ""}</span>
          <span className="text-[var(--muted)]">{t("os")}</span>
          <span>Ubuntu 24.04 LTS</span>
          <span className="text-[var(--muted)]">{t("billing")}</span>
          <span>
            <span className="text-[var(--accent)] font-bold">{sym}{plan?.price_monthly.toFixed(2)}/mo</span>
            {plan?.price_hourly ? (
              <span className="text-[var(--muted)] ml-2 text-xs">({sym}{plan.price_hourly.toFixed(4)}/h)</span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-3 text-xs text-[var(--muted)]">
        {t("serverBillingInfo", { provider: providerName })}
      </div>


      {error && (
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex justify-between pt-2">
        <button onClick={onBack} className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
          <ArrowLeft size={14} /> {tc("back")}
        </button>
        <button
          onClick={onCreate}
          disabled={creating}
          className="px-5 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {creating ? (
            <><Loader2 size={14} className="animate-spin" /> {t("creatingServer")}</>
          ) : (
            <><CloudUpload size={14} /> {t("createServerBtn")}</>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Step: Server Info (Connect) ─────────────────────────────────────

function StepInfo({ form, setForm, providers, canProceed, onNext, onBack }: {
  form: any; setForm: (f: any) => void; providers: { id: string; name: string }[];
  canProceed: boolean; onNext: () => void; onBack?: () => void;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium mb-1.5">{t("serverName")}</label>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t("serverNamePlaceholder")}
          className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors"
          autoFocus
        />
        <p className="text-xs text-[var(--muted)] mt-1">{t("serverNameHint")}</p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">{t("ipAddress")}</label>
        <input
          value={form.endpoint}
          onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
          placeholder={t("ipPlaceholder")}
          className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">{tc("provider")}</label>
        <div className="grid grid-cols-4 gap-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setForm({ ...form, provider: p.id })}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                form.provider === p.id
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--background)] border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50"
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-between pt-2">
        {onBack ? (
          <button onClick={onBack} className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
            <ArrowLeft size={14} /> {tc("back")}
          </button>
        ) : <div />}
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="px-5 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {tc("next")} <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Step: Connect ───────────────────────────────────────────────────

function StepConnect({ form, setForm, publicKey, copied, onCopy, showPassword, setShowPassword,
  testing, testResult, onTest, connecting, connectError, onConnect, onBack }: {
  form: any; setForm: (f: any) => void; publicKey: string; copied: boolean; onCopy: () => void;
  showPassword: boolean; setShowPassword: (v: boolean) => void;
  testing: boolean; testResult: { connected: boolean; hostname: string; error: string } | null;
  onTest: () => void; connecting: boolean; connectError: string; onConnect: () => void; onBack: () => void;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  return (
    <div className="space-y-5">
      {/* Auth method toggle */}
      <div>
        <label className="block text-sm font-medium mb-2">{t("connectionMethod")}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setForm({ ...form, usePassword: true })}
            className={`flex-1 px-4 py-2.5 rounded-lg text-xs font-medium transition-all ${
              form.usePassword
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--background)] border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50"
            }`}
          >
            <Zap size={14} className="inline mr-1.5 -mt-0.5" />
            {t("rootPassword")}
          </button>
          <button
            type="button"
            onClick={() => setForm({ ...form, usePassword: false })}
            className={`flex-1 px-4 py-2.5 rounded-lg text-xs font-medium transition-all ${
              !form.usePassword
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--background)] border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]/50"
            }`}
          >
            <Shield size={14} className="inline mr-1.5 -mt-0.5" />
            {t("sshKeyManual")}
          </button>
        </div>
      </div>

      {form.usePassword ? (
        <div className="space-y-4">
          <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-3 text-xs text-[var(--muted)]">
            {t("passwordHint")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">{t("sshUser")}</label>
              <input
                value={form.ssh_user}
                onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">{t("rootPasswordLabel")}</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={t("rootPasswordPlaceholder")}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-[var(--muted)]">
            {t("sshKeyInstruction")}
          </p>
          <div className="relative">
            <pre className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-3 text-xs font-mono break-all whitespace-pre-wrap max-h-20 overflow-y-auto">
              {publicKey || tc("loading")}
            </pre>
            <button
              onClick={onCopy}
              className="absolute top-2 right-2 p-1.5 bg-[var(--card)] border border-[var(--border)] rounded-md hover:bg-[var(--card-hover)]"
            >
              {copied ? <Check size={12} className="text-[var(--success)]" /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      )}

      {/* Test Connection */}
      <div className="flex items-center gap-3">
        <button
          onClick={onTest}
          disabled={testing || (!form.usePassword && !publicKey) || (form.usePassword && !form.password)}
          className="px-4 py-2 bg-[var(--background)] border border-[var(--border)] hover:border-[var(--accent)]/50 disabled:opacity-40 rounded-lg text-sm transition-colors flex items-center gap-2"
        >
          {testing ? <Loader2 size={14} className="animate-spin" /> : <Wifi size={14} />}
          {t("testConnection")}
        </button>
        {testResult && (
          <div className={`flex items-center gap-1.5 text-sm ${testResult.connected ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
            {testResult.connected ? (
              <>
                <CheckCircle2 size={16} />
                {t("connectedTo")} <span className="font-mono font-semibold">{testResult.hostname}</span>
              </>
            ) : (
              <>
                <XCircle size={16} />
                <span className="text-xs">{testResult.error || t("connectionFailed")}</span>
              </>
            )}
          </div>
        )}
      </div>

      {connectError && (
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">{connectError}</div>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <button
          onClick={onBack}
          className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2"
        >
          <ArrowLeft size={14} /> {tc("back")}
        </button>
        <button
          onClick={onConnect}
          disabled={connecting || (!form.usePassword && !testResult?.connected) || (form.usePassword && !form.password)}
          className="px-5 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          {connecting ? (
            <><Loader2 size={14} className="animate-spin" /> {t("scanning")}</>
          ) : (
            <><Scan size={14} /> {t("scanAndConnect")} <ArrowRight size={14} /></>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Step: Security Pre-Check ────────────────────────────────────

const severityColors: Record<string, string> = {
  critical: "text-red-400 bg-red-500/10 border-red-500/30",
  high: "text-orange-400 bg-orange-500/10 border-orange-500/30",
  medium: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  low: "text-blue-400 bg-blue-500/10 border-blue-500/30",
};
const severityIcons: Record<string, any> = {
  critical: Skull, high: Bug, medium: AlertTriangle, low: ShieldAlert,
};
const categoryIcons: Record<string, any> = {
  malware: Skull, access: UserX, persistence: Terminal,
  network: Network, integrity: ShieldX, resource_abuse: Cpu,
  compatibility: AlertTriangle, scan_error: XCircle,
};

function StepPrecheck({ precheckResult, sanitizeResult, sanitizing, connecting, connectError,
  onSanitize, onProceed, onBack }: {
  precheckResult: any; sanitizeResult: any; sanitizing: boolean; connecting: boolean;
  connectError: string; onSanitize: () => void; onProceed: () => void; onBack: () => void;
}) {
  const t = useTranslations("wizard");
  const tc = useTranslations("common");
  if (!precheckResult) return null;

  const { safe, risk_level, threats, system_info, recommendations } = precheckResult;
  const criticalThreats = (threats || []).filter((t: any) => t.severity === "critical");
  const highThreats = (threats || []).filter((t: any) => t.severity === "high");
  const otherThreats = (threats || []).filter((t: any) => t.severity !== "critical" && t.severity !== "high");

  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className={`rounded-xl p-4 border ${
        risk_level === "clean" ? "bg-emerald-500/10 border-emerald-500/30" :
        risk_level === "low" ? "bg-blue-500/10 border-blue-500/30" :
        risk_level === "medium" ? "bg-yellow-500/10 border-yellow-500/30" :
        "bg-red-500/10 border-red-500/30"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
            safe ? "bg-emerald-500/20" : "bg-red-500/20"
          }`}>
            {safe ? (
              <ShieldCheck size={28} className="text-emerald-400" />
            ) : (
              <ShieldX size={28} className="text-red-400" />
            )}
          </div>
          <div>
            <h3 className="font-semibold text-lg">
              {risk_level === "clean" ? t("precheck.serverClean") :
               risk_level === "low" ? t("precheck.minorIssues") :
               risk_level === "medium" ? t("precheck.securityIssues") :
               risk_level === "high" ? t("precheck.seriousThreats") :
               risk_level === "critical" ? t("precheck.criticalThreats") :
               t("precheck.scanIncomplete")}
            </h3>
            <p className="text-sm text-[var(--muted)]">
              {risk_level === "clean"
                ? t("precheck.noThreats")
                : t("precheck.issuesFound", { count: threats.length, safe: safe ? "true" : "false" })
              }
            </p>
          </div>
        </div>
      </div>

      {/* System Info */}
      {system_info && (system_info.os || system_info.kernel) && (
        <div className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-3">
          <div className="text-xs font-medium text-[var(--muted)] mb-2">{t("precheck.serverDetails")}</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {system_info.os && <><span className="text-[var(--muted)]">OS</span><span className="font-mono">{system_info.os}</span></>}
            {system_info.kernel && <><span className="text-[var(--muted)]">Kernel</span><span className="font-mono">{system_info.kernel}</span></>}
            {system_info.arch && <><span className="text-[var(--muted)]">Architecture</span><span className="font-mono">{system_info.arch}</span></>}
            {system_info.uptime && <><span className="text-[var(--muted)]">Uptime</span><span>{system_info.uptime}</span></>}
            {system_info.existing_containers && (
              <><span className="text-[var(--muted)]">Docker</span><span>{t("precheck.containersRunning", { count: system_info.existing_containers.length })}</span></>
            )}
          </div>
        </div>
      )}

      {/* Threats list */}
      {threats.length > 0 && (
        <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
          {[...criticalThreats, ...highThreats, ...otherThreats].map((threat: any, i: number) => {
            const SevIcon = severityIcons[threat.severity] || AlertTriangle;
            const CatIcon = categoryIcons[threat.category] || ShieldAlert;
            return (
              <div key={i} className={`flex items-start gap-3 rounded-lg p-3 border ${severityColors[threat.severity] || severityColors.low}`}>
                <CatIcon size={16} className="shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-bold uppercase">{threat.severity}</span>
                    <span className="text-[10px] opacity-60">{threat.category}</span>
                  </div>
                  <p className="text-xs break-words">{threat.detail}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Sanitize result */}
      {sanitizeResult && (
        <div className={`rounded-lg p-3 border ${
          sanitizeResult.success ? "bg-emerald-500/10 border-emerald-500/30" : "bg-orange-500/10 border-orange-500/30"
        }`}>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} className={sanitizeResult.success ? "text-emerald-400" : "text-orange-400"} />
            <span className="text-sm font-medium">
              {sanitizeResult.success ? t("precheck.sanitizationComplete") : t("precheck.partialSanitization")}
            </span>
          </div>
          <p className="text-xs text-[var(--muted)] mb-2">{sanitizeResult.message}</p>
          {sanitizeResult.actions?.length > 0 && (
            <div className="space-y-1">
              {sanitizeResult.actions.map((a: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
                  <span>{a.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recommendations */}
      {safe && recommendations?.length > 0 && (
        <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-3">
          <div className="text-xs font-medium mb-2">{t("precheck.duringProvisioning")}</div>
          <div className="space-y-1">
            {recommendations.map((r: string, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <CheckCircle2 size={10} className="text-[var(--accent)] shrink-0" />
                <span>{r}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {connectError && (
        <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">{connectError}</div>
      )}

      {/* Actions */}
      <div className="flex justify-between pt-2">
        <button onClick={onBack} className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-2">
          <ArrowLeft size={14} /> {tc("back")}
        </button>
        <div className="flex gap-2">
          {!safe && !sanitizeResult?.success && (
            <button
              onClick={onSanitize}
              disabled={sanitizing}
              className="px-4 py-2.5 bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 text-orange-300"
            >
              {sanitizing ? (
                <><Loader2 size={14} className="animate-spin" /> {t("precheck.sanitizing")}</>
              ) : (
                <><Sparkles size={14} /> {t("precheck.sanitizeServer")}</>
              )}
            </button>
          )}
          <button
            onClick={onProceed}
            disabled={connecting || sanitizing || (risk_level === "critical" && !sanitizeResult?.success)}
            className="px-5 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            title={risk_level === "critical" && !sanitizeResult?.success ? t("precheck.sanitizeFirst") : ""}
          >
            {connecting ? (
              <><Loader2 size={14} className="animate-spin" /> {t("connecting")}</>
            ) : (
              <><ShieldCheck size={14} /> {safe ? t("precheck.proceed") : t("precheck.proceedAnyway")} <ArrowRight size={14} /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Step: Done ──────────────────────────────────────────────────────

function StepDone({ server, onFinish, isCreate }: { server: any; onFinish: () => void; isCreate?: boolean }) {
  const t = useTranslations("wizard");
  const isOnline = server?.status === "online";
  const isProvisioning = server?.status === "provisioning";

  return (
    <div className="text-center py-4">
      <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
        isOnline ? "bg-[var(--success)]/10" : isProvisioning ? "bg-[var(--accent)]/10" : "bg-[var(--warning)]/10"
      }`}>
        {isOnline ? (
          <CheckCircle2 size={32} className="text-[var(--success)]" />
        ) : (
          <Loader2 size={32} className={`${isProvisioning ? "text-[var(--accent)]" : "text-[var(--warning)]"} animate-spin`} />
        )}
      </div>
      <h3 className="text-lg font-semibold mb-2">
        {isCreate
          ? (isProvisioning ? t("serverCreated") : isOnline ? t("serverReady") : t("serverCreated"))
          : (isOnline ? t("serverConnected") : t("serverAdded"))
        }
      </h3>
      <p className="text-sm text-[var(--muted)] mb-2">
        {isCreate ? (
          isProvisioning
            ? t("serverBeingSetup", { name: server?.name || "", endpoint: server?.endpoint || "..." })
            : isOnline
              ? t("serverOnline", { name: server?.name || "" })
              : t("serverCreatedIssue", { name: server?.name || "Server" })
        ) : (
          isOnline
            ? t("serverOnlineConfiguring", { name: server?.name || "" })
            : t("serverAddedFailed", { name: server?.name || "Server" })
        )}
      </p>
      {(isOnline || isProvisioning) && (
        <p className="text-xs text-[var(--muted)] mb-6">
          {t("serverEnvironmentPreparing")}
        </p>
      )}
      {server?.endpoint && (
        <p className="text-xs font-mono text-[var(--accent)] mb-4">{server.endpoint}</p>
      )}
      <button
        onClick={onFinish}
        className="px-6 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors"
      >
        {t("goToDashboard")}
      </button>
    </div>
  );
}
