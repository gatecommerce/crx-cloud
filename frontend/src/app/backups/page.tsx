"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { backupsApi, instancesApi } from "@/lib/api";
import {
  Database, Plus, RefreshCw, RotateCcw, Clock, HardDrive,
  CheckCircle, XCircle, Loader2
} from "lucide-react";

const statusIcons: Record<string, any> = {
  completed: CheckCircle,
  failed: XCircle,
  pending: Clock,
  in_progress: Loader2,
};

const statusColors: Record<string, string> = {
  completed: "text-[var(--success)]",
  failed: "text-[var(--danger)]",
  pending: "text-[var(--warning)]",
  in_progress: "text-[var(--accent)]",
};

interface Backup {
  id: string;
  instance_id: string;
  backup_type: string;
  status: string;
  storage_path?: string;
  size_mb?: number;
  created_at: string;
  completed_at?: string;
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [instances, setInstances] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [bkps, insts] = await Promise.all([
        backupsApi.list().catch(() => []),
        instancesApi.list().catch(() => []),
      ]);
      setBackups(bkps);
      setInstances(insts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function getInstanceName(id: string) {
    return instances.find((i) => i.id === id)?.name || "Unknown";
  }

  async function handleRestore(backupId: string) {
    if (!confirm("Restore this backup? The current instance data will be overwritten.")) return;
    try {
      await backupsApi.restore(backupId);
      alert("Restore initiated successfully.");
      loadData();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString("it-IT", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
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
                <h1 className="text-2xl font-bold">Backups</h1>
                <div className="flex gap-2">
                  <button onClick={loadData} className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                    <RefreshCw size={16} />
                  </button>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  >
                    <Plus size={16} /> Create Backup
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : backups.length === 0 ? (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                  <Database size={48} className="mx-auto text-[var(--muted)] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No backups yet</h3>
                  <p className="text-sm text-[var(--muted)] mb-4">Create your first backup to protect your data.</p>
                  <button
                    onClick={() => setShowCreate(true)}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium"
                  >
                    Create Backup
                  </button>
                </div>
              ) : (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                        <th className="text-left px-4 py-3">Status</th>
                        <th className="text-left px-4 py-3">Instance</th>
                        <th className="text-left px-4 py-3">Type</th>
                        <th className="text-left px-4 py-3">Size</th>
                        <th className="text-left px-4 py-3">Created</th>
                        <th className="text-right px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((bkp) => {
                        const Icon = statusIcons[bkp.status] || Clock;
                        const color = statusColors[bkp.status] || "text-[var(--muted)]";
                        return (
                          <tr key={bkp.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]">
                            <td className="px-4 py-3">
                              <div className={`flex items-center gap-2 ${color}`}>
                                <Icon size={14} className={bkp.status === "in_progress" ? "animate-spin" : ""} />
                                <span className="text-sm capitalize">{bkp.status}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-sm">{getInstanceName(bkp.instance_id)}</td>
                            <td className="px-4 py-3 text-sm text-[var(--muted)] capitalize">{bkp.backup_type}</td>
                            <td className="px-4 py-3 text-sm text-[var(--muted)]">
                              {bkp.size_mb ? `${bkp.size_mb} MB` : "-"}
                            </td>
                            <td className="px-4 py-3 text-sm text-[var(--muted)]">{formatDate(bkp.created_at)}</td>
                            <td className="px-4 py-3 text-right">
                              {bkp.status === "completed" && (
                                <button
                                  onClick={() => handleRestore(bkp.id)}
                                  className="text-xs px-3 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors flex items-center gap-1 ml-auto"
                                >
                                  <RotateCcw size={12} /> Restore
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </main>
          <VitoChat />
        </div>
      </div>

      {showCreate && (
        <CreateBackupModal
          instances={instances}
          onClose={() => setShowCreate(false)}
          onCreated={loadData}
        />
      )}
    </AuthGuard>
  );
}

function CreateBackupModal({ instances, onClose, onCreated }: { instances: any[]; onClose: () => void; onCreated: () => void }) {
  const [instanceId, setInstanceId] = useState(instances[0]?.id || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await backupsApi.create(instanceId);
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Create Backup</h2>
        {error && (
          <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Instance</label>
            <select
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              required
            >
              {instances.length === 0 && <option value="">No instances available</option>}
              {instances.map((i: any) => (
                <option key={i.id} value={i.id}>{i.name} ({i.cms_type})</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[var(--muted)]">Cancel</button>
            <button
              type="submit"
              disabled={loading || !instanceId}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium"
            >
              {loading ? "Creating..." : "Create Backup"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
