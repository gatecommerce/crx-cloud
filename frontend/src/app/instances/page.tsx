"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi, serversApi } from "@/lib/api";
import {
  Box, Plus, RefreshCw, Play, Square, RotateCcw, Trash2,
  ExternalLink, Cpu, MemoryStick, Users, Loader2, Search,
  Copy, Check, Dices, Eye, EyeOff, ChevronDown, ChevronUp,
  Globe, Server, Shield, Database, Settings, Info,
  LayoutList, LayoutGrid,
} from "lucide-react";

const statusColors: Record<string, string> = {
  running: "bg-emerald-500",
  stopped: "bg-gray-400",
  deploying: "bg-amber-500",
  error: "bg-red-500",
  updating: "bg-amber-500",
};

// statusLabels removed — now using t("status.running") etc. via useTranslations

const cmsLogos: Record<string, { label: string; color: string; bg: string }> = {
  odoo: { label: "Odoo", color: "text-purple-400", bg: "bg-purple-500/10" },
  wordpress: { label: "WordPress", color: "text-blue-400", bg: "bg-blue-500/10" },
  prestashop: { label: "PrestaShop", color: "text-pink-400", bg: "bg-pink-500/10" },
  woocommerce: { label: "WooCommerce", color: "text-violet-400", bg: "bg-violet-500/10" },
  custom: { label: "Custom", color: "text-gray-400", bg: "bg-gray-500/10" },
};

const editionColors: Record<string, string> = {
  community: "bg-gray-600 text-white",
  enterprise: "bg-emerald-700 text-white",
};

interface Instance {
  id: string;
  name: string;
  cms_type: string;
  version: string;
  status: string;
  domain?: string;
  url?: string;
  workers: number;
  ram_mb: number;
  cpu_cores: number;
  server_id: string;
  config?: Record<string, any>;
}

// ─── Languages & Countries for Odoo ─────────────────────────────────
const ODOO_LANGUAGES = [
  { code: "en_US", label: "English (US)" },
  { code: "it_IT", label: "Italiano" },
  { code: "fr_FR", label: "Français" },
  { code: "de_DE", label: "Deutsch" },
  { code: "es_ES", label: "Español" },
  { code: "pt_BR", label: "Português (BR)" },
  { code: "nl_NL", label: "Nederlands" },
  { code: "pl_PL", label: "Polski" },
  { code: "ru_RU", label: "Русский" },
  { code: "zh_CN", label: "中文 (简体)" },
  { code: "ja_JP", label: "日本語" },
  { code: "ar_001", label: "العربية" },
  { code: "tr_TR", label: "Türkçe" },
  { code: "ko_KR", label: "한국어" },
  { code: "uk_UA", label: "Українська" },
  { code: "ro_RO", label: "Română" },
  { code: "cs_CZ", label: "Čeština" },
  { code: "hu_HU", label: "Magyar" },
  { code: "sv_SE", label: "Svenska" },
  { code: "da_DK", label: "Dansk" },
  { code: "fi_FI", label: "Suomi" },
  { code: "el_GR", label: "Ελληνικά" },
  { code: "he_IL", label: "עברית" },
  { code: "th_TH", label: "ภาษาไทย" },
  { code: "vi_VN", label: "Tiếng Việt" },
];

const COUNTRIES = [
  { code: "", label: "Select country..." },
  { code: "IT", label: "Italy" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "ES", label: "Spain" },
  { code: "PT", label: "Portugal" },
  { code: "BR", label: "Brazil" },
  { code: "NL", label: "Netherlands" },
  { code: "BE", label: "Belgium" },
  { code: "CH", label: "Switzerland" },
  { code: "AT", label: "Austria" },
  { code: "PL", label: "Poland" },
  { code: "RO", label: "Romania" },
  { code: "CZ", label: "Czech Republic" },
  { code: "HU", label: "Hungary" },
  { code: "SE", label: "Sweden" },
  { code: "DK", label: "Denmark" },
  { code: "FI", label: "Finland" },
  { code: "NO", label: "Norway" },
  { code: "GR", label: "Greece" },
  { code: "TR", label: "Turkey" },
  { code: "RU", label: "Russia" },
  { code: "UA", label: "Ukraine" },
  { code: "IN", label: "India" },
  { code: "CN", label: "China" },
  { code: "JP", label: "Japan" },
  { code: "KR", label: "South Korea" },
  { code: "AU", label: "Australia" },
  { code: "CA", label: "Canada" },
  { code: "MX", label: "Mexico" },
  { code: "AR", label: "Argentina" },
  { code: "CL", label: "Chile" },
  { code: "CO", label: "Colombia" },
  { code: "ZA", label: "South Africa" },
  { code: "AE", label: "United Arab Emirates" },
  { code: "SA", label: "Saudi Arabia" },
  { code: "IL", label: "Israel" },
  { code: "EG", label: "Egypt" },
  { code: "MA", label: "Morocco" },
  { code: "TN", label: "Tunisia" },
];

// ─── Main Page ──────────────────────────────────────────────────────

export default function InstancesPage() {
  const t = useTranslations("instances");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeploy, setShowDeploy] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  const loadData = useCallback(async () => {
    try {
      const [inst, srv] = await Promise.all([
        instancesApi.list().catch(() => []),
        serversApi.list().catch(() => []),
      ]);
      setInstances(inst);
      setServers(srv);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const filteredInstances = useMemo(() => {
    if (!searchQuery) return instances;
    const q = searchQuery.toLowerCase();
    return instances.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.domain?.toLowerCase().includes(q) ||
        i.cms_type.toLowerCase().includes(q)
    );
  }, [instances, searchQuery]);

  async function handleAction(id: string, action: "restart" | "stop" | "start") {
    setActionLoading(`${id}-${action}`);
    try {
      await instancesApi[action](id);
      await loadData();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    if (!confirm(t("confirmDelete", { name }))) return;
    setActionLoading(`${id}-delete`);
    try {
      await instancesApi.remove(id);
      setInstances((prev) => prev.filter((i) => i.id !== id));
    } catch (err: any) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  function getServer(serverId: string) {
    return servers.find((s) => s.id === serverId);
  }

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">{t("title")}</h1>
                <div className="flex items-center gap-2">
                  {/* Search */}
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t("searchInstances")}
                      className="pl-8 pr-3 py-2 bg-[var(--card)] border border-[var(--border)] rounded-lg text-sm w-48 focus:outline-none focus:border-[var(--accent)] focus:w-64 transition-all"
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
                  <button onClick={loadData} className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                    <RefreshCw size={16} />
                  </button>
                  <button
                    onClick={() => setShowDeploy(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <Plus size={16} /> {t("deployInstance")}
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : instances.length === 0 ? (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                  <Box size={48} className="mx-auto text-[var(--muted)] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h3>
                  <p className="text-sm text-[var(--muted)] mb-4">{t("emptyDescription")}</p>
                  <button
                    onClick={() => setShowDeploy(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium"
                  >
                    {t("deployInstance")}
                  </button>
                </div>
              ) : viewMode === "list" ? (
                /* ─── List View (CloudPepper-style table) ──────────── */
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[var(--border)]">
                        <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("primaryDomain")}</th>
                        <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("server")}</th>
                        <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{tCommon("status")}</th>
                        <th className="text-left text-xs font-normal text-[var(--muted)] px-5 py-3">{t("editionLabel")}</th>
                        <th className="text-right text-xs font-normal text-[var(--muted)] px-5 py-3">{tCommon("actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInstances.map((inst) => {
                        const srv = getServer(inst.server_id);
                        const cms = cmsLogos[inst.cms_type] || cmsLogos.custom;
                        const edition = inst.config?.edition || "community";
                        return (
                          <tr
                            key={inst.id}
                            onClick={() => router.push(`/instances/${inst.id}`)}
                            className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)] cursor-pointer transition-colors"
                          >
                            {/* Domain */}
                            <td className="px-5 py-4">
                              <div className="flex items-center gap-2">
                                {inst.domain ? (
                                  <a
                                    href={inst.url || `https://${inst.domain}`}
                                    target="_blank"
                                    rel="noopener"
                                    className="text-sm font-medium text-[var(--accent)] hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {inst.domain}
                                  </a>
                                ) : (
                                  <span className="text-sm font-medium">{inst.name}</span>
                                )}
                              </div>
                            </td>
                            {/* Server + version badge */}
                            <td className="px-5 py-4">
                              <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                                {srv?.provider && (
                                  <span className="text-xs font-medium capitalize">{srv.provider}</span>
                                )}
                                <span className="truncate max-w-[300px]">{srv?.name || tCommon("unknown")}</span>
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white">
                                  {inst.version}
                                </span>
                              </div>
                            </td>
                            {/* Status */}
                            <td className="px-5 py-4">
                              <div className="flex items-center gap-2">
                                <div className={`w-2.5 h-2.5 rounded-full ${statusColors[inst.status]}`} />
                                <span className="text-sm">{t(`status.${inst.status}` as any) || inst.status}</span>
                                {inst.status === "deploying" && <Loader2 size={12} className="animate-spin text-amber-500" />}
                              </div>
                            </td>
                            {/* Edition */}
                            <td className="px-5 py-4">
                              <span className={`text-[10px] font-semibold px-2 py-1 rounded ${editionColors[edition] || editionColors.community}`}>
                                {t(`edition.${edition}` as any)}
                              </span>
                            </td>
                            {/* Actions */}
                            <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-end gap-1">
                                {inst.status === "running" ? (
                                  <>
                                    <button
                                      onClick={() => handleAction(inst.id, "restart")}
                                      disabled={!!actionLoading}
                                      className="p-1.5 rounded hover:bg-[var(--border)] transition-colors disabled:opacity-50"
                                      title={t("restart")}
                                    >
                                      {actionLoading === `${inst.id}-restart` ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                                    </button>
                                    <button
                                      onClick={() => handleAction(inst.id, "stop")}
                                      disabled={!!actionLoading}
                                      className="p-1.5 rounded hover:bg-[var(--border)] transition-colors text-amber-500 disabled:opacity-50"
                                      title={t("stop")}
                                    >
                                      {actionLoading === `${inst.id}-stop` ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
                                    </button>
                                  </>
                                ) : inst.status === "stopped" ? (
                                  <button
                                    onClick={() => handleAction(inst.id, "start")}
                                    disabled={!!actionLoading}
                                    className="p-1.5 rounded hover:bg-emerald-500/10 text-emerald-500 transition-colors disabled:opacity-50"
                                    title={t("start")}
                                  >
                                    {actionLoading === `${inst.id}-start` ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                                  </button>
                                ) : null}
                                <button
                                  onClick={(e) => handleDelete(e, inst.id, inst.name)}
                                  disabled={!!actionLoading}
                                  className="p-1.5 rounded hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                                  title={tCommon("delete")}
                                >
                                  {actionLoading === `${inst.id}-delete` ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {/* Footer counter */}
                  <div className="text-right text-xs text-[var(--muted)] px-5 py-3 border-t border-[var(--border)]">
                    {t("showing")} <span className="font-semibold text-[var(--accent)]">{filteredInstances.length}</span> {t("of")} <span className="font-semibold text-[var(--accent)]">{instances.length}</span>.
                  </div>
                </div>
              ) : (
                /* ─── Grid View (cards) ─────────────────────────────── */
                <>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {filteredInstances.map((inst) => {
                      const srv = getServer(inst.server_id);
                      const cms = cmsLogos[inst.cms_type] || cmsLogos.custom;
                      const edition = inst.config?.edition || "community";
                      const isDeploying = inst.status === "deploying";
                      return (
                        <div
                          key={inst.id}
                          onClick={() => router.push(`/instances/${inst.id}`)}
                          className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 transition-colors cursor-pointer"
                        >
                          {/* Header */}
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-2.5 h-2.5 rounded-full ${statusColors[inst.status]}`} />
                              <h3 className="font-semibold text-sm truncate">{inst.domain || inst.name}</h3>
                              {isDeploying && <Loader2 size={12} className="animate-spin text-amber-500" />}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white">
                                {inst.version}
                              </span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${editionColors[edition]}`}>
                                {edition === "enterprise" ? t("edition.enterprise") : t("edition.community")}
                              </span>
                            </div>
                          </div>

                          {/* Server info */}
                          <div className="space-y-2 mb-4">
                            <div className="text-xs text-[var(--muted)] flex items-center gap-2">
                              <Server size={12} />
                              <span className="truncate">{srv?.name || tCommon("unknown")}</span>
                              {srv?.provider && (
                                <span className="text-[10px] capitalize font-medium">{srv.provider}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
                              <span className="flex items-center gap-1"><Cpu size={12} /> {inst.cpu_cores}c</span>
                              <span className="flex items-center gap-1"><MemoryStick size={12} /> {inst.ram_mb >= 1024 ? `${(inst.ram_mb / 1024).toFixed(0)}GB` : `${inst.ram_mb}MB`}</span>
                              <span className="flex items-center gap-1"><Users size={12} /> {inst.workers}w</span>
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex gap-2 border-t border-[var(--border)] pt-3" onClick={(e) => e.stopPropagation()}>
                            {inst.status === "running" ? (
                              <>
                                <button onClick={() => handleAction(inst.id, "restart")} disabled={!!actionLoading} className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-md bg-[var(--background)] hover:bg-[var(--border)] transition-colors disabled:opacity-50">
                                  {actionLoading === `${inst.id}-restart` ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {t("restart")}
                                </button>
                                <button onClick={() => handleAction(inst.id, "stop")} disabled={!!actionLoading} className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-md bg-[var(--background)] hover:bg-[var(--border)] transition-colors text-amber-500 disabled:opacity-50">
                                  {actionLoading === `${inst.id}-stop` ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} {t("stop")}
                                </button>
                              </>
                            ) : inst.status === "stopped" ? (
                              <button onClick={() => handleAction(inst.id, "start")} disabled={!!actionLoading} className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-md bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                                {actionLoading === `${inst.id}-start` ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} {t("start")}
                              </button>
                            ) : (
                              <div className="flex-1 text-center text-xs py-1.5 text-[var(--muted)]">
                                {inst.status === "deploying" ? t("deploying") : inst.status}
                              </div>
                            )}
                            <button onClick={(e) => handleDelete(e, inst.id, inst.name)} disabled={!!actionLoading} className="flex items-center justify-center gap-1 text-xs py-1.5 px-3 rounded-md text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                              {actionLoading === `${inst.id}-delete` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-right text-xs text-[var(--muted)] mt-4">
                    {t("showing")} <span className="font-semibold text-[var(--accent)]">{filteredInstances.length}</span> {t("of")} <span className="font-semibold text-[var(--accent)]">{instances.length}</span>.
                  </div>
                </>
              )}
            </div>
          </main>
          <VitoChat />
        </div>
      </div>

      {/* Deploy Modal */}
      {showDeploy && (
        <DeployModal
          servers={servers.filter((s) => s.status === "online")}
          onClose={() => setShowDeploy(false)}
          onDeployed={loadData}
        />
      )}
    </AuthGuard>
  );
}

// ─── Password Generator Utility ─────────────────────────────────────

function generatePassword(length = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+-";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

function generateSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "my-instance";
}

// ─── Enterprise Deploy Modal ────────────────────────────────────────

function DeployModal({
  servers,
  onClose,
  onDeployed,
}: {
  servers: any[];
  onClose: () => void;
  onDeployed: () => void;
}) {
  const t = useTranslations("instances");
  const tCommon = useTranslations("common");
  const [step, setStep] = useState(1); // 1=basic, 2=review
  const [form, setForm] = useState({
    name: "",
    cms_type: "odoo",
    version: "19.0",
    server_id: servers[0]?.id || "",
    domain: "",
    auto_domain: true,
    ram_mb: 2048,
    cpu_cores: 1,
    admin_password: generatePassword(),
    language: "en_US",
    country: "",
    db_name: "",
    edition: "community",
    demo_data: false,
    use_external_db: false,
    external_db_host: "",
    external_db_port: 5432,
    external_db_name: "",
    external_db_user: "",
    external_db_password: "",
  });
  // Compute selected server specs for resource limits
  const selectedServer = servers.find((s) => s.id === form.server_id);
  const serverSpecs = selectedServer?.specs;
  // Round up raw RAM to nearest standard tier (free -m reports usable RAM, e.g. 7950 for 8GB)
  const rawRamMb = serverSpecs?.ram_mb || 32768;
  const ramTiers = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const maxRamMb = ramTiers.find((t) => t >= rawRamMb * 0.9) || rawRamMb;
  const maxCpuCores = serverSpecs?.cpu_cores || 16;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const versions: Record<string, string[]> = {
    odoo: ["19.0", "18.0", "17.0", "16.0"],
    wordpress: ["6.8", "6.7", "6.6"],
    prestashop: ["9.0", "8.2", "8.1"],
    woocommerce: ["6.8", "6.7"],
  };

  const isOdoo = form.cms_type === "odoo";

  // Auto-generated domain preview
  const subdomain = generateSubdomain(form.name || "my-instance");
  const fullDomain = form.auto_domain ? `${subdomain}.site.crx.team` : form.domain;

  function handleCopyPassword() {
    navigator.clipboard.writeText(form.admin_password);
    setPasswordCopied(true);
    setTimeout(() => setPasswordCopied(false), 2000);
  }

  function handleRegeneratePassword() {
    setForm({ ...form, admin_password: generatePassword() });
    setPasswordCopied(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordSaved) return;
    setLoading(true);
    setError("");
    try {
      const payload: any = {
        name: form.name,
        cms_type: form.cms_type,
        version: form.version,
        server_id: form.server_id,
        domain: fullDomain || "",
        ram_mb: form.ram_mb,
        cpu_cores: form.cpu_cores,
        admin_password: form.admin_password,
        language: form.language,
        country: form.country,
        db_name: form.db_name || subdomain.replace(/-/g, "_"),
        edition: form.edition,
        demo_data: form.demo_data,
        auto_domain: form.auto_domain,
        use_external_db: form.use_external_db,
        ...(form.use_external_db ? {
          external_db_host: form.external_db_host,
          external_db_port: form.external_db_port,
          external_db_name: form.external_db_name,
          external_db_user: form.external_db_user,
          external_db_password: form.external_db_password,
        } : {}),
      };
      await instancesApi.create(payload);
      onDeployed();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputClass = "w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] transition-colors";
  const labelClass = "block text-xs font-medium text-[var(--muted)] mb-1.5";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div
        className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-[var(--card)] border-b border-[var(--border)] px-6 py-4 flex items-center justify-between z-10 rounded-t-xl">
          <h2 className="text-lg font-semibold">{t("deployNewInstance")}</h2>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--foreground)] text-xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">{error}</div>
          )}

          {/* Server selection */}
          <div>
            <label className={labelClass}>{t("server")}</label>
            <div className="space-y-2">
              {servers.length === 0 ? (
                <div className="text-sm text-[var(--muted)] bg-[var(--background)] rounded-lg px-4 py-3">
                  {t("noServersAvailable")}
                </div>
              ) : (
                servers.map((s) => (
                  <label
                    key={s.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors ${form.server_id === s.id ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] hover:border-[var(--accent)]/30"}`}
                  >
                    <input
                      type="radio"
                      name="server"
                      checked={form.server_id === s.id}
                      onChange={() => {
                      const specs = s.specs;
                      const newForm = { ...form, server_id: s.id };
                      // Clamp resources to server limits
                      if (specs) {
                        if (newForm.cpu_cores > specs.cpu_cores) newForm.cpu_cores = specs.cpu_cores;
                        if (newForm.ram_mb > specs.ram_mb) {
                          // Find largest valid RAM option
                          const opts = [512, 1024, 2048, 4096, 8192, 16384, 32768].filter(v => v <= specs.ram_mb);
                          newForm.ram_mb = opts.length > 0 ? opts[opts.length - 1] : 512;
                        }

                      }
                      setForm(newForm);
                    }}
                      className="accent-[var(--accent)]"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{s.name}</div>
                      <div className="text-xs text-[var(--muted)]">
                        {s.provider && <span className="capitalize">{s.provider} &middot; </span>}
                        {s.endpoint}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* CMS + Version + Name */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>{tCommon("type")}</label>
              <select
                value={form.cms_type}
                onChange={(e) => setForm({ ...form, cms_type: e.target.value, version: versions[e.target.value]?.[0] || "" })}
                className={inputClass}
              >
                <option value="odoo">{t("cms.odoo")}</option>
                <option value="wordpress">{t("cms.wordpress")}</option>
                <option value="prestashop">{t("cms.prestashop")}</option>
                <option value="woocommerce">{t("cms.woocommerce")}</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>{tCommon("version")}</label>
              <select
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                className={inputClass}
              >
                {(versions[form.cms_type] || []).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t("instanceName")}</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-erp-prod"
                className={inputClass}
                required
              />
            </div>
          </div>

          {/* Domain */}
          <div>
            <label className={labelClass}>{t("domainName")}</label>
            <div className="flex items-center gap-3">
              {form.auto_domain ? (
                <div className="flex-1 flex items-center gap-0 bg-[var(--background)] border border-[var(--border)] rounded-lg overflow-hidden">
                  <input
                    value={subdomain}
                    readOnly
                    className="flex-1 bg-transparent px-3 py-2 text-sm focus:outline-none"
                  />
                  <span className="px-3 py-2 text-sm text-[var(--muted)] bg-[var(--border)]/30 border-l border-[var(--border)]">.site.crx.team</span>
                </div>
              ) : (
                <input
                  value={form.domain}
                  onChange={(e) => setForm({ ...form, domain: e.target.value })}
                  placeholder="erp.example.com"
                  className={`flex-1 ${inputClass}`}
                />
              )}
              <div className="flex items-center gap-1">
                {fullDomain && <Check size={16} className="text-emerald-500" />}
              </div>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <label className="flex items-center gap-2 text-xs text-[var(--muted)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_domain}
                  onChange={(e) => setForm({ ...form, auto_domain: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                {t("autoGenerateDomain")}
              </label>
              {!form.auto_domain && (
                <span className="text-[10px] text-[var(--muted)]">{t("domainChangeLater")}</span>
              )}
            </div>
          </div>

          {/* Admin Password — security-first UX */}
          <div>
            <label className={labelClass}>{t("adminPassword")}</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={form.admin_password}
                  onChange={(e) => setForm({ ...form, admin_password: e.target.value })}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                type="button"
                onClick={handleRegeneratePassword}
                className="p-2 rounded-lg border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
                title={t("generateNewPassword")}
              >
                <Dices size={16} className="text-[var(--muted)]" />
              </button>
              <button
                type="button"
                onClick={handleCopyPassword}
                className="p-2 rounded-lg border border-[var(--border)] hover:bg-[var(--border)] transition-colors"
                title={t("copyPassword")}
              >
                {passwordCopied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} className="text-[var(--muted)]" />}
              </button>
            </div>
            <p className="text-xs text-red-400 mt-1.5 font-medium">
              {t("passwordWarning")}
            </p>
          </div>

          {/* Advanced options toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-[var(--accent)] hover:underline"
          >
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
          </button>

          {/* Advanced options */}
          {showAdvanced && (
            <div className="space-y-4 pl-4 border-l-2 border-[var(--accent)]/20">
              {/* Database name */}
              <div>
                <label className={labelClass}>{t("databaseName")}</label>
                <input
                  value={form.db_name || subdomain.replace(/-/g, "_")}
                  onChange={(e) => setForm({ ...form, db_name: e.target.value })}
                  placeholder="my_database"
                  className={inputClass}
                />
                <p className="text-[10px] text-[var(--muted)] mt-1">
                  {isOdoo ? t("odooDatabaseName") : t("databaseName")}
                </p>
              </div>

              {/* Demo data toggle */}
              <div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <div
                    onClick={() => setForm({ ...form, demo_data: !form.demo_data })}
                    className={`w-10 h-5 rounded-full transition-colors cursor-pointer flex items-center ${form.demo_data ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
                  >
                    <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${form.demo_data ? "translate-x-5" : ""}`} />
                  </div>
                  <span className="text-sm font-medium">{t("installDemoData")}</span>
                </label>
                <p className="text-[10px] text-amber-500 mt-1">
                  {t("demoDataWarning")}
                </p>
              </div>

              {/* External DB toggle */}
              <div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <div
                    onClick={() => setForm({ ...form, use_external_db: !form.use_external_db })}
                    className={`w-10 h-5 rounded-full transition-colors cursor-pointer flex items-center ${form.use_external_db ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
                  >
                    <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${form.use_external_db ? "translate-x-5" : ""}`} />
                  </div>
                  <span className="text-sm font-medium">{t("useExternalDb")}</span>
                </label>
                <p className="text-[10px] text-[var(--muted)] mt-1">
                  {t("externalDbDescription")}
                </p>
              </div>

              {/* External DB fields */}
              {form.use_external_db && (
                <div className="space-y-3 bg-[var(--background)] rounded-lg p-4 border border-[var(--border)]">
                  <div>
                    <label className={labelClass}>{t("dbHost")}</label>
                    <input
                      value={form.external_db_host}
                      onChange={(e) => setForm({ ...form, external_db_host: e.target.value })}
                      placeholder={t("dbHostPlaceholder")}
                      className={inputClass}
                    />
                    <p className="text-[10px] text-[var(--muted)] mt-1">{t("dbHostDescription")}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>{t("dbPort")}</label>
                      <input
                        type="number"
                        value={form.external_db_port}
                        onChange={(e) => setForm({ ...form, external_db_port: parseInt(e.target.value) || 5432 })}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t("databaseName")}</label>
                      <input
                        value={form.external_db_name || form.db_name || subdomain.replace(/-/g, "_")}
                        onChange={(e) => setForm({ ...form, external_db_name: e.target.value })}
                        placeholder={t("odooDatabaseName")}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>{t("dbUser")}</label>
                      <input
                        value={form.external_db_user}
                        onChange={(e) => setForm({ ...form, external_db_user: e.target.value })}
                        placeholder={t("dbUserPlaceholder")}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t("dbPassword")}</label>
                      <input
                        type="password"
                        value={form.external_db_password}
                        onChange={(e) => setForm({ ...form, external_db_password: e.target.value })}
                        placeholder={t("dbPasswordPlaceholder")}
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
                    <p className="font-semibold mb-1"><Info size={12} className="inline mr-1" />{t("externalDbTip")}</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>{t("externalDbTip1")}</li>
                      <li>{t("externalDbTip2")}</li>
                    </ol>
                  </div>
                </div>
              )}

              {/* Language & Country (Odoo only) */}
              {isOdoo && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>{t("language")}</label>
                    <select
                      value={form.language}
                      onChange={(e) => setForm({ ...form, language: e.target.value })}
                      className={inputClass}
                    >
                      {ODOO_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>{t("country")}</label>
                    <select
                      value={form.country}
                      onChange={(e) => setForm({ ...form, country: e.target.value })}
                      className={inputClass}
                    >
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>{c.code === "" ? t("selectCountry") : c.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Resources — limited by server specs */}
              {serverSpecs && (
                <p className="text-[10px] text-[var(--muted)] mb-1">
                  {t("server")}: {serverSpecs.cpu_cores} vCPU, {serverSpecs.ram_mb >= 1024 ? `${(serverSpecs.ram_mb / 1024).toFixed(0)} GB` : `${serverSpecs.ram_mb} MB`} RAM, {serverSpecs.disk_gb} GB disk
                </p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>{t("ram")}</label>
                  <select
                    value={form.ram_mb}
                    onChange={(e) => setForm({ ...form, ram_mb: parseInt(e.target.value) })}
                    className={inputClass}
                  >
                    {[512, 1024, 2048, 4096, 8192, 16384, 32768]
                      .filter((v) => v <= maxRamMb)
                      .map((v) => (
                        <option key={v} value={v}>
                          {v >= 1024 ? `${v / 1024} GB` : `${v} MB`}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>{t("cpuCores")}</label>
                  <select
                    value={form.cpu_cores}
                    onChange={(e) => setForm({ ...form, cpu_cores: parseInt(e.target.value) })}
                    className={inputClass}
                  >
                    {[1, 2, 4, 8, 16, 32]
                      .filter((v) => v <= maxCpuCores)
                      .map((v) => (
                        <option key={v} value={v}>
                          {v} {v > 1 ? t("cores") : t("core")}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Password saved confirmation gate */}
          <label className="flex items-center gap-3 cursor-pointer py-2">
            <input
              type="checkbox"
              checked={passwordSaved}
              onChange={(e) => setPasswordSaved(e.target.checked)}
              className="w-4 h-4 accent-[var(--accent)]"
            />
            <span className="text-sm">{t("passwordSavedConfirm")}</span>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] font-medium"
            >
              {tCommon("cancel")}
            </button>
            <button
              type="submit"
              disabled={loading || !form.server_id || !form.name || !passwordSaved}
              className="px-6 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition-colors"
            >
              {loading ? (
                <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t("deploying")}</span>
              ) : (
                t("createInstance")
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
