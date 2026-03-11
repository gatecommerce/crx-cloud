"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi, serversApi } from "@/lib/api";
import {
  Box, Plus, RefreshCw, Play, Square, RotateCcw, Trash2,
  ExternalLink, Cpu, MemoryStick, Users
} from "lucide-react";

const statusColors: Record<string, string> = {
  running: "bg-[var(--success)]",
  stopped: "bg-[var(--muted)]",
  deploying: "bg-[var(--warning)]",
  error: "bg-[var(--danger)]",
  updating: "bg-[var(--warning)]",
};

const cmsLogos: Record<string, { label: string; color: string }> = {
  odoo: { label: "Odoo", color: "text-purple-400" },
  wordpress: { label: "WordPress", color: "text-blue-400" },
  prestashop: { label: "PrestaShop", color: "text-pink-400" },
  woocommerce: { label: "WooCommerce", color: "text-violet-400" },
  custom: { label: "Custom", color: "text-gray-400" },
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
  created_at: string;
}

export default function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeploy, setShowDeploy] = useState(false);

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
  }, [loadData]);

  async function handleRestart(id: string) {
    try {
      await instancesApi.restart(id);
      loadData();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete instance "${name}"? This cannot be undone.`)) return;
    try {
      await instancesApi.remove(id);
      setInstances((prev) => prev.filter((i) => i.id !== id));
    } catch (err: any) {
      alert(err.message);
    }
  }

  function getServerName(serverId: string) {
    return servers.find((s) => s.id === serverId)?.name || "Unknown";
  }

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Instances</h1>
                <div className="flex gap-2">
                  <button onClick={loadData} className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                    <RefreshCw size={16} />
                  </button>
                  <button
                    onClick={() => setShowDeploy(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <Plus size={16} /> Deploy Instance
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
                  <h3 className="text-lg font-semibold mb-2">No instances yet</h3>
                  <p className="text-sm text-[var(--muted)] mb-4">Deploy your first CMS instance on one of your servers.</p>
                  <button
                    onClick={() => setShowDeploy(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium"
                  >
                    Deploy Instance
                  </button>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {instances.map((inst) => {
                    const cms = cmsLogos[inst.cms_type] || cmsLogos.custom;
                    return (
                      <div key={inst.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 transition-colors">
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-2.5 h-2.5 rounded-full ${statusColors[inst.status]}`} />
                            <h3 className="font-semibold text-sm">{inst.name}</h3>
                          </div>
                          <span className={`text-xs font-medium ${cms.color}`}>{cms.label} {inst.version}</span>
                        </div>

                        {/* Info */}
                        <div className="space-y-2 mb-4">
                          {inst.domain && (
                            <div className="flex items-center gap-2 text-xs">
                              <ExternalLink size={12} className="text-[var(--muted)]" />
                              <a href={inst.url || `https://${inst.domain}`} target="_blank" rel="noopener" className="text-[var(--accent)] hover:underline truncate">
                                {inst.domain}
                              </a>
                            </div>
                          )}
                          <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
                            <span className="flex items-center gap-1"><Cpu size={12} /> {inst.cpu_cores} cores</span>
                            <span className="flex items-center gap-1"><MemoryStick size={12} /> {inst.ram_mb}MB</span>
                            <span className="flex items-center gap-1"><Users size={12} /> {inst.workers}w</span>
                          </div>
                          <div className="text-xs text-[var(--muted)]">
                            Server: {getServerName(inst.server_id)}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 border-t border-[var(--border)] pt-3">
                          <button
                            onClick={() => handleRestart(inst.id)}
                            className="flex-1 flex items-center justify-center gap-1 text-xs py-1.5 rounded-md bg-[var(--background)] hover:bg-[var(--border)] transition-colors"
                          >
                            <RotateCcw size={12} /> Restart
                          </button>
                          <button
                            onClick={() => handleDelete(inst.id, inst.name)}
                            className="flex items-center justify-center gap-1 text-xs py-1.5 px-3 rounded-md text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
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

function DeployModal({ servers, onClose, onDeployed }: { servers: any[]; onClose: () => void; onDeployed: () => void }) {
  const [form, setForm] = useState({
    name: "",
    cms_type: "odoo",
    version: "18.0",
    server_id: servers[0]?.id || "",
    domain: "",
    workers: 2,
    ram_mb: 1024,
    cpu_cores: 1,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const versions: Record<string, string[]> = {
    odoo: ["18.0", "17.0", "16.0"],
    wordpress: ["6.8", "6.7", "6.6"],
    prestashop: ["9.0", "8.2", "8.1"],
    woocommerce: ["6.8", "6.7"],
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await instancesApi.create(form);
      onDeployed();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Deploy New Instance</h2>
        {error && (
          <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Instance Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="my-odoo-prod"
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Server</label>
              <select
                value={form.server_id}
                onChange={(e) => setForm({ ...form, server_id: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                required
              >
                {servers.length === 0 && <option value="">No servers available</option>}
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.server_type})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">CMS</label>
              <select
                value={form.cms_type}
                onChange={(e) => setForm({ ...form, cms_type: e.target.value, version: versions[e.target.value]?.[0] || "" })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="odoo">Odoo</option>
                <option value="wordpress">WordPress</option>
                <option value="prestashop">PrestaShop</option>
                <option value="woocommerce">WooCommerce</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Version</label>
              <select
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                {(versions[form.cms_type] || []).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Domain (optional)</label>
            <input
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              placeholder="erp.example.com"
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Workers</label>
              <input
                type="number"
                value={form.workers}
                onChange={(e) => setForm({ ...form, workers: parseInt(e.target.value) || 1 })}
                min={1}
                max={16}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">RAM (MB)</label>
              <select
                value={form.ram_mb}
                onChange={(e) => setForm({ ...form, ram_mb: parseInt(e.target.value) })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value={512}>512 MB</option>
                <option value={1024}>1 GB</option>
                <option value={2048}>2 GB</option>
                <option value={4096}>4 GB</option>
                <option value={8192}>8 GB</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">CPU Cores</label>
              <select
                value={form.cpu_cores}
                onChange={(e) => setForm({ ...form, cpu_cores: parseInt(e.target.value) })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value={1}>1 core</option>
                <option value={2}>2 cores</option>
                <option value={4}>4 cores</option>
                <option value={8}>8 cores</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !form.server_id}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? "Deploying..." : "Deploy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
