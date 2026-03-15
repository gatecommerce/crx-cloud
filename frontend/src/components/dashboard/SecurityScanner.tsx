"use client";

import React, { useState, useCallback } from "react";
import { serversApi } from "@/lib/api";
import {
  Loader2, ShieldCheck, ShieldAlert, Shield, AlertTriangle,
  CheckCircle, XCircle, RefreshCw, Wrench, ChevronDown, ChevronUp,
  Package, Globe, Lock, Server, Terminal,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────

interface SecurityScannerProps {
  serverId: string;
}

// ─── Risk Score Gauge ───────────────────────────────────────────────

function RiskGauge({ score, level }: { score: number; level: string }) {
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : score >= 40 ? "#f97316" : "#ef4444";
  const label = score >= 80 ? "Low Risk" : score >= 60 ? "Medium Risk" : score >= 40 ? "High Risk" : "Critical Risk";

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-28 h-28">
        <svg className="w-28 h-28 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="45" fill="none" stroke="var(--border)" strokeWidth="8" />
          <circle
            cx="50" cy="50" r="45" fill="none"
            stroke={color} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>{score}</span>
          <span className="text-[8px] text-[var(--muted)] uppercase tracking-wider">/ 100</span>
        </div>
      </div>
      <span className="text-xs font-medium mt-2" style={{ color }}>{label}</span>
    </div>
  );
}

// ─── Severity Badge ─────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    critical: "bg-red-500/15 text-red-500 border-red-500/30",
    high: "bg-orange-500/15 text-orange-500 border-orange-500/30",
    medium: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
    low: "bg-blue-500/15 text-blue-500 border-blue-500/30",
  };
  return (
    <span className={`px-2 py-0.5 text-[10px] uppercase font-semibold rounded-full border ${styles[severity] || styles.low}`}>
      {severity}
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function SecurityScanner({ serverId }: SecurityScannerProps) {
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [scan, setScan] = useState<any>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["packages", "ports", "recommendations"]));

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await serversApi.securityScan(serverId);
      setScan(result);
    } catch { /* ignore */ }
    finally { setScanning(false); }
  }, [serverId]);

  const loadCached = useCallback(async () => {
    try {
      const result = await serversApi.securityScanHistory(serverId);
      if (result?.scan_time) setScan(result);
    } catch { /* ignore */ }
  }, [serverId]);

  // Load cached results on mount
  React.useEffect(() => { loadCached(); }, [loadCached]);

  const handleFix = async (action: string) => {
    setFixing(action);
    try {
      await serversApi.securityFix(serverId, [action]);
      // Re-scan after fix
      runScan();
    } catch { /* ignore */ }
    finally { setFixing(null); }
  };

  return (
    <div className="space-y-6">
      {/* Header + Scan Button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Shield size={16} /> Vulnerability Scanner
          </h3>
          {scan?.scan_time && (
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Last scan: {new Date(scan.scan_time).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {scanning ? "Scanning..." : scan ? "Re-scan" : "Run Security Scan"}
        </button>
      </div>

      {/* Scanning animation */}
      {scanning && !scan && (
        <div className="text-center py-16">
          <div className="relative inline-block">
            <Shield size={48} className="text-[var(--accent)] animate-pulse" />
            <Loader2 size={20} className="absolute -top-1 -right-1 text-[var(--accent)] animate-spin" />
          </div>
          <p className="text-[var(--muted)] text-sm mt-4">Analyzing server security...</p>
          <p className="text-[var(--muted)] text-xs mt-1">This may take 30-60 seconds</p>
        </div>
      )}

      {/* Results */}
      {scan && !scanning && (
        <>
          {/* Overview Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 flex justify-center">
              <RiskGauge score={scan.risk_score} level={scan.risk_level} />
            </div>
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 md:col-span-3">
              <h4 className="text-xs text-[var(--muted)] mb-3 uppercase tracking-wider">Vulnerability Summary</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Critical", count: scan.summary?.critical || 0, color: "text-red-500" },
                  { label: "High", count: scan.summary?.high || 0, color: "text-orange-500" },
                  { label: "Medium", count: scan.summary?.medium || 0, color: "text-yellow-500" },
                  { label: "Low", count: scan.summary?.low || 0, color: "text-blue-500" },
                ].map(v => (
                  <div key={v.label} className="text-center">
                    <div className={`text-3xl font-bold ${v.color}`}>{v.count}</div>
                    <div className="text-xs text-[var(--muted)]">{v.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* SSH Security */}
          {scan.ssh_security && (
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
              <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Lock size={16} /> SSH Security
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="flex items-center gap-2">
                  {scan.ssh_security.password_auth === "no" ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <XCircle size={14} className="text-red-500" />
                  )}
                  <span className="text-xs">Password Auth: {scan.ssh_security.password_auth}</span>
                </div>
                <div className="flex items-center gap-2">
                  {scan.ssh_security.root_login === "no" || scan.ssh_security.root_login === "prohibit-password" ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <XCircle size={14} className="text-red-500" />
                  )}
                  <span className="text-xs">Root Login: {scan.ssh_security.root_login}</span>
                </div>
                <div className="text-xs text-[var(--muted)]">
                  Port: {scan.ssh_security.ssh_port || 22}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  Failed logins (24h): {scan.ssh_security.failed_logins_24h || 0}
                </div>
              </div>
            </div>
          )}

          {/* System Health */}
          {scan.system_health && (
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6">
              <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Server size={16} /> System Health
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="flex items-center gap-2">
                  {scan.system_health.unattended_upgrades ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <XCircle size={14} className="text-red-500" />
                  )}
                  <span className="text-xs">Auto Updates</span>
                </div>
                <div className="flex items-center gap-2">
                  {!scan.system_health.reboot_required ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <AlertTriangle size={14} className="text-yellow-500" />
                  )}
                  <span className="text-xs">{scan.system_health.reboot_required ? "Reboot Required" : "No Reboot Needed"}</span>
                </div>
                <div className="text-xs text-[var(--muted)]">
                  Last update: {scan.system_health.last_update_days_ago != null ? `${scan.system_health.last_update_days_ago}d ago` : "N/A"}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  Kernel: {scan.system_health.kernel_version || "N/A"}
                </div>
              </div>
            </div>
          )}

          {/* Outdated Packages */}
          {scan.os_updates?.packages?.length > 0 && (
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
              <button
                onClick={() => toggleSection("packages")}
                className="w-full flex items-center justify-between p-4 hover:bg-[var(--card-hover)] transition-colors"
              >
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Package size={16} />
                  Outdated Packages ({scan.os_updates.packages.length})
                  {scan.os_updates.security_updates_available > 0 && (
                    <span className="px-2 py-0.5 text-[10px] bg-red-500/15 text-red-500 rounded-full border border-red-500/30">
                      {scan.os_updates.security_updates_available} security
                    </span>
                  )}
                </h4>
                {expandedSections.has("packages") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {expandedSections.has("packages") && (
                <div className="px-4 pb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[var(--muted)]">
                        <th className="text-left py-2 font-medium">Package</th>
                        <th className="text-left py-2 font-medium">Current</th>
                        <th className="text-left py-2 font-medium">Available</th>
                        <th className="text-left py-2 font-medium">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scan.os_updates.packages.slice(0, 30).map((pkg: any, i: number) => (
                        <tr key={i} className="border-b border-[var(--border)]/30">
                          <td className="py-1.5 font-mono">{pkg.name}</td>
                          <td className="py-1.5 text-[var(--muted)]">{pkg.current}</td>
                          <td className="py-1.5 text-emerald-500">{pkg.available}</td>
                          <td className="py-1.5">
                            {pkg.severity ? <SeverityBadge severity={pkg.severity} /> : (
                              <span className="text-[var(--muted)]">{pkg.type || "update"}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {scan.os_updates.packages.length > 30 && (
                    <p className="text-xs text-[var(--muted)] mt-2">...and {scan.os_updates.packages.length - 30} more</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Open Ports */}
          {scan.open_ports?.length > 0 && (
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
              <button
                onClick={() => toggleSection("ports")}
                className="w-full flex items-center justify-between p-4 hover:bg-[var(--card-hover)] transition-colors"
              >
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Globe size={16} /> Open Ports ({scan.open_ports.length})
                </h4>
                {expandedSections.has("ports") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {expandedSections.has("ports") && (
                <div className="px-4 pb-4">
                  <div className="space-y-2">
                    {scan.open_ports.map((port: any, i: number) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-[var(--border)]/30 last:border-0">
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm font-medium w-16">{port.port}/{port.protocol}</span>
                          <span className="text-xs text-[var(--muted)]">{port.process || "unknown"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {port.note && <span className="text-xs text-yellow-500">{port.note}</span>}
                          <SeverityBadge severity={port.risk || "low"} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Recommendations */}
          {scan.recommendations?.length > 0 && (
            <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
              <button
                onClick={() => toggleSection("recommendations")}
                className="w-full flex items-center justify-between p-4 hover:bg-[var(--card-hover)] transition-colors"
              >
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <Wrench size={16} /> Recommendations ({scan.recommendations.length})
                </h4>
                {expandedSections.has("recommendations") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {expandedSections.has("recommendations") && (
                <div className="px-4 pb-4 space-y-2">
                  {scan.recommendations.map((rec: any, i: number) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-[var(--border)]/30 last:border-0">
                      <div className="flex items-center gap-3">
                        <SeverityBadge severity={rec.priority} />
                        <span className="text-xs">{rec.action}</span>
                      </div>
                      {rec.fixable !== false && rec.fix_action && (
                        <button
                          onClick={() => handleFix(rec.fix_action)}
                          disabled={fixing === rec.fix_action}
                          className="px-3 py-1 text-xs bg-[var(--accent)]/10 text-[var(--accent)] rounded-lg hover:bg-[var(--accent)]/20 flex items-center gap-1"
                        >
                          {fixing === rec.fix_action ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Terminal size={12} />
                          )}
                          Auto-fix
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!scan && !scanning && (
        <div className="text-center py-16">
          <ShieldCheck size={48} className="text-[var(--muted)] mx-auto mb-3" />
          <p className="text-[var(--muted)] text-sm">Run a security scan to detect vulnerabilities</p>
          <p className="text-[var(--muted)] text-xs mt-1">Checks OS packages, open ports, SSH config, Docker images</p>
        </div>
      )}
    </div>
  );
}
