"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi, backupsApi, serversApi } from "@/lib/api";
import {
  ArrowLeft, Play, Square, RotateCcw, Trash2, ExternalLink,
  Cpu, MemoryStick, Users, Heart, ScrollText, Database,
  Loader2, CheckCircle, XCircle, AlertTriangle, Clock,
  RefreshCw, Plus, ChevronDown, ChevronUp, Globe
} from "lucide-react";

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
  const [activeTab, setActiveTab] = useState<"overview" | "logs" | "backups">("overview");
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logLines, setLogLines] = useState(50);

  const loadInstance = useCallback(async () => {
    try {
      const inst = await instancesApi.get(instanceId);
      setInstance(inst);
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
      setLogs(data.logs || []);
    } catch {
      setLogs(["Failed to load logs"]);
    }
  }, [instanceId, logLines]);

  useEffect(() => {
    loadInstance();
  }, [loadInstance]);

  useEffect(() => {
    if (instance && instance.status === "running") {
      loadHealth();
    }
  }, [instance, loadHealth]);

  useEffect(() => {
    if (activeTab === "logs") {
      loadLogs();
    }
  }, [activeTab, loadLogs]);

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
                  <button
                    onClick={handleDelete}
                    disabled={!!actionLoading}
                    className="px-3 py-2 text-sm rounded-lg text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    {actionLoading === "delete" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mb-6 border-b border-[var(--border)]">
                {(["overview", "logs", "backups"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors ${
                      activeTab === tab
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {tab === "overview" && <Heart size={14} className="inline mr-1.5" />}
                    {tab === "logs" && <ScrollText size={14} className="inline mr-1.5" />}
                    {tab === "backups" && <Database size={14} className="inline mr-1.5" />}
                    {tab}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              {activeTab === "overview" && (
                <div className="grid gap-4 md:grid-cols-2">
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

              {activeTab === "backups" && (
                <div>
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
            </div>
          </main>
          <VitoChat />
        </div>
      </div>
    </AuthGuard>
  );
}
