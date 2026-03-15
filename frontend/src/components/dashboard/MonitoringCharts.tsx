"use client";

import React, { useEffect, useState, useCallback } from "react";
import { serversApi } from "@/lib/api";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  Loader2, RefreshCw, AlertTriangle, Download, Clock,
  Cpu, MemoryStick, HardDrive, Network, Bell, BellOff,
  CheckCircle, XCircle, Info,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────

interface MetricsHistoryProps {
  serverId: string;
  active: boolean;
}

interface AlertConfig {
  cpu_warning: number;
  cpu_critical: number;
  memory_warning: number;
  memory_critical: number;
  disk_warning: number;
  disk_critical: number;
  load_warning_multiplier: number;
  enabled: boolean;
}

const PERIODS = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  cpu_warning: 80,
  cpu_critical: 95,
  memory_warning: 80,
  memory_critical: 95,
  disk_warning: 80,
  disk_critical: 90,
  load_warning_multiplier: 2.0,
  enabled: false,
};

const chartColors = {
  cpu_user: "#3b82f6",
  cpu_system: "#f59e0b",
  cpu_iowait: "#ef4444",
  memory: "#8b5cf6",
  cached: "#06b6d4",
  disk_read: "#10b981",
  disk_write: "#f97316",
  net_rx: "#3b82f6",
  net_tx: "#ef4444",
};

// ─── Custom Tooltip ─────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg px-3 py-2 shadow-lg text-xs">
      <div className="text-[var(--muted)] mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-[var(--foreground)]">{p.name}: {typeof p.value === "number" ? p.value.toFixed(1) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Alert Status Badge ─────────────────────────────────────────────

function AlertBadge({ level, message }: { level: string; message: string }) {
  const config = {
    critical: { icon: XCircle, color: "text-red-500 bg-red-500/10 border-red-500/30" },
    warning: { icon: AlertTriangle, color: "text-yellow-500 bg-yellow-500/10 border-yellow-500/30" },
    info: { icon: Info, color: "text-blue-500 bg-blue-500/10 border-blue-500/30" },
  }[level] || { icon: Info, color: "text-[var(--muted)] bg-[var(--card)] border-[var(--border)]" };
  const Icon = config.icon;
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${config.color}`}>
      <Icon size={14} />
      <span>{message}</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function MonitoringCharts({ serverId, active }: MetricsHistoryProps) {
  const [period, setPeriod] = useState("1h");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<any>(null);
  const [alerts, setAlerts] = useState<any>(null);
  const [alertConfig, setAlertConfig] = useState<AlertConfig>(DEFAULT_ALERT_CONFIG);
  const [showAlertConfig, setShowAlertConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await serversApi.metricsHistory(serverId, period);
      setHistory(data);
    } catch {
      /* ignore — will show empty state */
    } finally {
      setLoading(false);
    }
  }, [serverId, period]);

  const loadAlerts = useCallback(async () => {
    try {
      const [status, config] = await Promise.allSettled([
        serversApi.alertsStatus(serverId),
        serversApi.alertsConfig(serverId),
      ]);
      if (status.status === "fulfilled") setAlerts(status.value);
      if (config.status === "fulfilled") setAlertConfig({ ...DEFAULT_ALERT_CONFIG, ...config.value });
    } catch { /* ignore */ }
  }, [serverId]);

  useEffect(() => {
    if (active) {
      loadHistory();
      loadAlerts();
    }
  }, [active, loadHistory, loadAlerts]);

  const handleSaveAlertConfig = async () => {
    setSavingConfig(true);
    try {
      await serversApi.updateAlertsConfig(serverId, alertConfig);
      await loadAlerts();
    } catch { /* ignore */ }
    finally { setSavingConfig(false); }
  };

  const handleInstallSysstat = async () => {
    try {
      await serversApi.installSysstat(serverId);
      loadHistory();
    } catch { /* ignore */ }
  };

  if (loading && !history) {
    return <div className="flex justify-center py-20"><Loader2 size={28} className="animate-spin text-[var(--accent)]" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Active Alerts */}
      {alerts?.alerts?.length > 0 && (
        <div className="space-y-2">
          {alerts.alerts.map((a: any, i: number) => (
            <AlertBadge key={i} level={a.level} message={a.message} />
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                period === p.value
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--card)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAlertConfig(!showAlertConfig)}
            className={`p-2 rounded-lg border transition-colors ${
              alertConfig.enabled
                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
            title="Alert Configuration"
          >
            {alertConfig.enabled ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
          <button
            onClick={loadHistory}
            disabled={loading}
            className="p-2 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Alert Configuration Panel */}
      {showAlertConfig && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Bell size={16} /> Alert Configuration
            </h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-[var(--muted)]">Enabled</span>
              <button
                onClick={() => setAlertConfig(c => ({ ...c, enabled: !c.enabled }))}
                className={`w-9 h-5 rounded-full transition-colors relative ${alertConfig.enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${alertConfig.enabled ? "left-4" : "left-0.5"}`} />
              </button>
            </label>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { key: "cpu_warning", label: "CPU Warning %", icon: Cpu },
              { key: "cpu_critical", label: "CPU Critical %", icon: Cpu },
              { key: "memory_warning", label: "RAM Warning %", icon: MemoryStick },
              { key: "memory_critical", label: "RAM Critical %", icon: MemoryStick },
              { key: "disk_warning", label: "Disk Warning %", icon: HardDrive },
              { key: "disk_critical", label: "Disk Critical %", icon: HardDrive },
            ].map(({ key, label, icon: Icon }) => (
              <div key={key}>
                <label className="text-xs text-[var(--muted)] flex items-center gap-1">
                  <Icon size={12} /> {label}
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={(alertConfig as any)[key]}
                  onChange={e => setAlertConfig(c => ({ ...c, [key]: Number(e.target.value) }))}
                  className="w-full mt-1 px-3 py-1.5 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <button
              onClick={handleSaveAlertConfig}
              disabled={savingConfig}
              className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm flex items-center gap-2"
            >
              {savingConfig && <Loader2 size={14} className="animate-spin" />}
              Save
            </button>
          </div>
        </div>
      )}

      {/* Sysstat not installed banner */}
      {history && !history.sar_available && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle size={18} className="text-yellow-500" />
            <div>
              <div className="text-sm font-medium text-yellow-500">Historical data not available</div>
              <div className="text-xs text-[var(--muted)]">Install sysstat to enable CPU/RAM/Disk/Network history charts</div>
            </div>
          </div>
          <button
            onClick={handleInstallSysstat}
            className="px-4 py-2 bg-yellow-500 text-black rounded-lg text-sm font-medium hover:bg-yellow-400 transition-colors"
          >
            <Download size={14} className="inline mr-1" /> Install sysstat
          </button>
        </div>
      )}

      {/* CPU Chart */}
      {history?.cpu?.length > 0 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Cpu size={16} /> CPU Usage
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={history.cpu} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
              <defs>
                <linearGradient id="cpuUserGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.cpu_user} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={chartColors.cpu_user} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="cpuSysGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.cpu_system} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={chartColors.cpu_system} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} unit="%" />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Area type="monotone" dataKey="user" name="User" stroke={chartColors.cpu_user} fill="url(#cpuUserGrad)" strokeWidth={2} />
              <Area type="monotone" dataKey="system" name="System" stroke={chartColors.cpu_system} fill="url(#cpuSysGrad)" strokeWidth={2} />
              <Area type="monotone" dataKey="iowait" name="I/O Wait" stroke={chartColors.cpu_iowait} fill="none" strokeWidth={1.5} strokeDasharray="4 2" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Memory Chart */}
      {history?.memory?.length > 0 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <MemoryStick size={16} /> Memory Usage
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={history.memory} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
              <defs>
                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.memory} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={chartColors.memory} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--muted)" }} unit="%" />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Area type="monotone" dataKey="used_percent" name="Used %" stroke={chartColors.memory} fill="url(#memGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Disk I/O Chart */}
      {history?.disk_io?.length > 0 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <HardDrive size={16} /> Disk I/O
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history.disk_io} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} unit=" MB/s" />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Line type="monotone" dataKey="read_mb_s" name="Read" stroke={chartColors.disk_read} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="write_mb_s" name="Write" stroke={chartColors.disk_write} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Network Chart */}
      {history?.network?.length > 0 && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Network size={16} /> Network Traffic
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history.network} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--muted)" }} />
              <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} unit=" KB/s" />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: "11px" }} />
              <Line type="monotone" dataKey="rx_kb_s" name="RX (in)" stroke={chartColors.net_rx} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="tx_kb_s" name="TX (out)" stroke={chartColors.net_tx} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* No data state */}
      {history && !history.cpu?.length && !history.memory?.length && (
        <div className="text-center py-16">
          <Clock size={48} className="text-[var(--muted)] mx-auto mb-3" />
          <p className="text-[var(--muted)] text-sm">No historical data available yet</p>
          <p className="text-[var(--muted)] text-xs mt-1">Install sysstat to start collecting metrics history</p>
        </div>
      )}
    </div>
  );
}
