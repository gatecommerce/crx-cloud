"use client";

import { useEffect, useState, useCallback } from "react";
import { serversApi } from "@/lib/api";
import { Server as ServerIcon, Cpu, MemoryStick, HardDrive, Trash2, RefreshCw, Plus, Wifi, WifiOff } from "lucide-react";

interface ServerData {
  id: string;
  name: string;
  server_type: string;
  provider: string;
  status: string;
  endpoint: string;
  region?: string;
  instances?: any[];
}

interface Metrics {
  cpu_percent?: number;
  ram_percent?: number;
  disk_percent?: number;
  pods?: number;
}

const statusColors: Record<string, string> = {
  online: "bg-[var(--success)]",
  offline: "bg-[var(--danger)]",
  provisioning: "bg-[var(--warning)]",
  error: "bg-[var(--danger)]",
};

const cmsIcons: Record<string, string> = {
  odoo: "O",
  wordpress: "W",
  prestashop: "P",
  woocommerce: "WC",
};

export function ServerList() {
  const [servers, setServers] = useState<ServerData[]>([]);
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const loadServers = useCallback(async () => {
    try {
      const data = await serversApi.list();
      setServers(data);
      // Load metrics for online servers
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

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove server "${name}"?`)) return;
    try {
      await serversApi.remove(id);
      setServers((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Servers</h1>
        <div className="flex gap-2">
          <button
            onClick={loadServers}
            className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] transition-colors"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Plus size={16} /> Add Server
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
          <ServerIcon size={48} className="mx-auto text-[var(--muted)] mb-4" />
          <h3 className="text-lg font-semibold mb-2">No servers yet</h3>
          <p className="text-sm text-[var(--muted)] mb-4">Add your first server to start deploying CMS instances.</p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors"
          >
            Add Server
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {servers.map((server) => {
            const m = metrics[server.id];
            return (
              <div
                key={server.id}
                className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 transition-colors"
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${statusColors[server.status] || "bg-[var(--muted)]"}`} />
                    <h3 className="font-semibold">{server.name}</h3>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--muted)]">
                      {server.server_type === "kubernetes" ? "K8s" : "VM"}
                    </span>
                    {server.status === "online" ? (
                      <Wifi size={14} className="text-[var(--success)]" />
                    ) : (
                      <WifiOff size={14} className="text-[var(--danger)]" />
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[var(--muted)]">{server.provider}</span>
                    {server.region && (
                      <span className="text-xs text-[var(--muted)]">{server.region}</span>
                    )}
                    <button
                      onClick={() => handleDelete(server.id, server.name)}
                      className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Metrics */}
                {server.status === "online" && m && (
                  <div className="flex gap-6 mb-4">
                    <MetricBar label="CPU" value={m.cpu_percent} icon={Cpu} />
                    <MetricBar label="RAM" value={m.ram_percent} icon={MemoryStick} />
                    <MetricBar label="Disk" value={m.disk_percent} icon={HardDrive} />
                    {m.pods !== undefined && (
                      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                        Pods: <span className="font-semibold text-[var(--foreground)]">{m.pods}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Instances */}
                {server.instances && server.instances.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {server.instances.map((inst: any) => (
                      <span
                        key={inst.id}
                        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-[var(--background)] border border-[var(--border)]"
                      >
                        <span className="font-mono font-bold text-[var(--accent)]">
                          {cmsIcons[inst.cms_type] || "?"}
                        </span>
                        {inst.name}
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            inst.status === "running" ? "bg-[var(--success)]" : "bg-[var(--muted)]"
                          }`}
                        />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Server Modal */}
      {showAdd && <AddServerModal onClose={() => setShowAdd(false)} onAdded={loadServers} />}
    </>
  );
}

function MetricBar({ label, value, icon: Icon }: { label: string; value?: number; icon: any }) {
  const v = value ?? 0;
  const color = v > 90 ? "bg-[var(--danger)]" : v > 70 ? "bg-[var(--warning)]" : "bg-[var(--accent)]";
  return (
    <div className="flex-1">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-[var(--muted)] flex items-center gap-1">
          <Icon size={12} /> {label}
        </span>
        <span>{v}%</span>
      </div>
      <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

function AddServerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    name: "",
    server_type: "vm",
    provider: "hetzner",
    endpoint: "",
    ssh_user: "root",
    ssh_key_path: "",
    kubeconfig: "",
    namespace: "default",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await serversApi.add(form);
      onAdded();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const isK8s = form.server_type === "kubernetes";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Add Server</h2>
        {error && (
          <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Type</label>
              <select
                value={form.server_type}
                onChange={(e) => setForm({ ...form, server_type: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="vm">Virtual Machine</option>
                <option value="kubernetes">Kubernetes</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Provider</label>
              <select
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value })}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="hetzner">Hetzner</option>
                <option value="azure">Azure</option>
                <option value="aws">AWS</option>
                <option value="gcp">Google Cloud</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">
                {isK8s ? "API Server" : "Host / IP"}
              </label>
              <input
                value={form.endpoint}
                onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                placeholder={isK8s ? "https://k8s-api:6443" : "192.168.1.100"}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                required
              />
            </div>
          </div>

          {isK8s ? (
            <>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Kubeconfig (YAML)</label>
                <textarea
                  value={form.kubeconfig}
                  onChange={(e) => setForm({ ...form, kubeconfig: e.target.value })}
                  rows={4}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                  placeholder="Paste your kubeconfig here..."
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Namespace</label>
                <input
                  value={form.namespace}
                  onChange={(e) => setForm({ ...form, namespace: e.target.value })}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">SSH User</label>
                <input
                  value={form.ssh_user}
                  onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">SSH Key Path</label>
                <input
                  value={form.ssh_key_path}
                  onChange={(e) => setForm({ ...form, ssh_key_path: e.target.value })}
                  placeholder="~/.ssh/id_rsa"
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? "Connecting..." : "Add Server"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
