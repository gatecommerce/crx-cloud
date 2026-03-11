"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi, serversApi } from "@/lib/api";
import {
  Activity, RefreshCw, CheckCircle, XCircle, AlertTriangle,
  Cpu, MemoryStick, HardDrive, Loader2
} from "lucide-react";

interface InstanceHealth {
  id: string;
  name: string;
  cms_type: string;
  status: string;
  health?: {
    healthy?: boolean;
    http_status?: number;
    container_status?: string;
    response_time_ms?: number;
  };
  loading: boolean;
}

interface ServerMetrics {
  id: string;
  name: string;
  status: string;
  endpoint: string;
  cpu_percent?: number;
  ram_percent?: number;
  disk_percent?: number;
}

export default function MonitoringPage() {
  const [instances, setInstances] = useState<InstanceHealth[]>([]);
  const [servers, setServers] = useState<ServerMetrics[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [insts, srvs] = await Promise.all([
        instancesApi.list().catch(() => []),
        serversApi.list().catch(() => []),
      ]);

      // Initialize instance health entries
      const healthEntries: InstanceHealth[] = insts.map((i: any) => ({
        id: i.id,
        name: i.name,
        cms_type: i.cms_type,
        status: i.status,
        loading: i.status === "running",
      }));
      setInstances(healthEntries);

      // Load server metrics
      const serverEntries: ServerMetrics[] = srvs.map((s: any) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        endpoint: s.endpoint,
      }));
      setServers(serverEntries);

      // Fetch health for running instances
      for (const inst of healthEntries) {
        if (inst.status === "running") {
          instancesApi.health(inst.id).then((h) => {
            setInstances((prev) =>
              prev.map((i) =>
                i.id === inst.id ? { ...i, health: h, loading: false } : i
              )
            );
          }).catch(() => {
            setInstances((prev) =>
              prev.map((i) =>
                i.id === inst.id ? { ...i, loading: false } : i
              )
            );
          });
        }
      }

      // Fetch server metrics
      for (const srv of serverEntries) {
        if (srv.status === "online") {
          serversApi.metrics(srv.id).then((m) => {
            setServers((prev) =>
              prev.map((s) =>
                s.id === srv.id ? { ...s, ...m } : s
              )
            );
          }).catch(() => {});
        }
      }

      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const healthyCount = instances.filter((i) => i.health?.healthy).length;
  const unhealthyCount = instances.filter((i) => i.status === "running" && i.health && !i.health.healthy).length;
  const errorCount = instances.filter((i) => i.status === "error").length;

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl font-bold">Monitoring</h1>
                  <p className="text-xs text-[var(--muted)] mt-1">
                    Last refresh: {lastRefresh.toLocaleTimeString("it-IT")}
                  </p>
                </div>
                <button
                  onClick={loadData}
                  disabled={loading}
                  className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] disabled:opacity-50"
                >
                  <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                </button>
              </div>

              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <SummaryCard icon={CheckCircle} label="Healthy" value={healthyCount} color="text-[var(--success)]" />
                <SummaryCard icon={AlertTriangle} label="Unhealthy" value={unhealthyCount} color="text-[var(--warning)]" />
                <SummaryCard icon={XCircle} label="Errors" value={errorCount} color="text-[var(--danger)]" />
                <SummaryCard icon={Activity} label="Total" value={instances.length} color="text-[var(--accent)]" />
              </div>

              {/* Server Resources */}
              {servers.length > 0 && (
                <div className="mb-6">
                  <h2 className="text-sm font-semibold mb-3">Server Resources</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    {servers.map((srv) => (
                      <div key={srv.id} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${srv.status === "online" ? "bg-[var(--success)]" : "bg-[var(--danger)]"}`} />
                            <span className="text-sm font-medium">{srv.name}</span>
                          </div>
                          <span className="text-xs text-[var(--muted)]">{srv.endpoint}</span>
                        </div>
                        <div className="space-y-3">
                          <ResourceBar label="CPU" value={srv.cpu_percent} icon={Cpu} />
                          <ResourceBar label="RAM" value={srv.ram_percent} icon={MemoryStick} />
                          <ResourceBar label="Disk" value={srv.disk_percent} icon={HardDrive} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Instance Health */}
              <h2 className="text-sm font-semibold mb-3">Instance Health</h2>
              {instances.length === 0 ? (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8 text-center">
                  <Activity size={32} className="mx-auto text-[var(--muted)] mb-3" />
                  <p className="text-sm text-[var(--muted)]">No instances to monitor.</p>
                </div>
              ) : (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                        <th className="text-left px-4 py-3">Status</th>
                        <th className="text-left px-4 py-3">Instance</th>
                        <th className="text-left px-4 py-3">Type</th>
                        <th className="text-left px-4 py-3">HTTP</th>
                        <th className="text-left px-4 py-3">Container</th>
                        <th className="text-left px-4 py-3">Response</th>
                      </tr>
                    </thead>
                    <tbody>
                      {instances.map((inst) => (
                        <tr key={inst.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]">
                          <td className="px-4 py-3">
                            {inst.loading ? (
                              <Loader2 size={14} className="text-[var(--accent)] animate-spin" />
                            ) : inst.health?.healthy ? (
                              <CheckCircle size={14} className="text-[var(--success)]" />
                            ) : inst.status === "stopped" ? (
                              <div className="w-3.5 h-3.5 rounded-full bg-[var(--muted)]" />
                            ) : inst.status === "error" ? (
                              <XCircle size={14} className="text-[var(--danger)]" />
                            ) : inst.health ? (
                              <AlertTriangle size={14} className="text-[var(--warning)]" />
                            ) : (
                              <div className="w-3.5 h-3.5 rounded-full bg-[var(--muted)]" />
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm font-medium">{inst.name}</td>
                          <td className="px-4 py-3 text-sm text-[var(--muted)] capitalize">{inst.cms_type}</td>
                          <td className="px-4 py-3 text-sm text-[var(--muted)]">
                            {inst.health?.http_status || "-"}
                          </td>
                          <td className="px-4 py-3 text-sm text-[var(--muted)]">
                            {inst.health?.container_status || inst.status}
                          </td>
                          <td className="px-4 py-3 text-sm text-[var(--muted)]">
                            {inst.health?.response_time_ms !== undefined ? `${inst.health.response_time_ms}ms` : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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

function SummaryCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={color} />
        <span className="text-xs text-[var(--muted)]">{label}</span>
      </div>
      <span className="text-2xl font-bold">{value}</span>
    </div>
  );
}

function ResourceBar({ label, value, icon: Icon }: { label: string; value?: number; icon: any }) {
  const v = value ?? 0;
  const color = v > 90 ? "bg-[var(--danger)]" : v > 70 ? "bg-[var(--warning)]" : "bg-[var(--accent)]";
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-[var(--muted)] flex items-center gap-1"><Icon size={12} /> {label}</span>
        <span className="font-medium">{v > 0 ? `${v}%` : "-"}</span>
      </div>
      <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
