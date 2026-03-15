"use client";

import React, { useState, useCallback, useEffect } from "react";
import { serversApi } from "@/lib/api";
import {
  Loader2, Shield, ShieldAlert, ShieldCheck, RefreshCw,
  Ban, Unlock, Plus, ChevronDown, ChevronUp, AlertTriangle,
  Power, PowerOff, X,
} from "lucide-react";

interface Fail2banManagerProps {
  serverId: string;
  active: boolean;
}

export function Fail2banManager({ serverId, active }: Fail2banManagerProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedJails, setExpandedJails] = useState<Set<string>>(new Set());
  const [banModal, setBanModal] = useState<{ jail: string } | null>(null);
  const [banIp, setBanIp] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await serversApi.fail2ban(serverId);
      setData(result);
      // Auto-expand jails with bans
      const withBans = new Set<string>();
      result?.jails?.forEach((j: any) => {
        if (j.currently_banned > 0) withBans.add(j.name);
      });
      setExpandedJails(withBans);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [serverId]);

  useEffect(() => {
    if (active) loadData();
  }, [active, loadData]);

  const handleToggle = async (enabled: boolean) => {
    setActionLoading("toggle");
    try {
      await serversApi.fail2banToggle(serverId, enabled);
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleUnban = async (jail: string, ip: string) => {
    setActionLoading(`unban-${jail}-${ip}`);
    try {
      await serversApi.fail2banUnban(serverId, jail, ip);
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleBan = async () => {
    if (!banModal || !banIp) return;
    setActionLoading(`ban-${banModal.jail}`);
    try {
      await serversApi.fail2banBan(serverId, banModal.jail, banIp);
      setBanModal(null);
      setBanIp("");
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const toggleJail = (name: string) => {
    setExpandedJails(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (loading && !data) {
    return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-[var(--accent)]" /></div>;
  }

  const totalBanned = data?.jails?.reduce((sum: number, j: any) => sum + (j.currently_banned || 0), 0) || 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <ShieldAlert size={16} /> Fail2ban
          </h4>
          {data && (
            <span className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${
              data.active
                ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/30"
                : "bg-red-500/10 text-red-500 border border-red-500/30"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${data.active ? "bg-emerald-500" : "bg-red-500"}`} />
              {data.active ? "Active" : "Inactive"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <button
              onClick={() => handleToggle(!data.active)}
              disabled={actionLoading === "toggle"}
              className={`px-3 py-1.5 text-xs rounded-lg flex items-center gap-1.5 ${
                data.active
                  ? "bg-red-500/10 text-red-500 hover:bg-red-500/20"
                  : "bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20"
              }`}
            >
              {actionLoading === "toggle" ? <Loader2 size={12} className="animate-spin" /> : data.active ? <PowerOff size={12} /> : <Power size={12} />}
              {data.active ? "Stop" : "Start"}
            </button>
          )}
          <button onClick={loadData} disabled={loading} className="p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Stats */}
      {data?.active && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-[var(--background)] rounded-lg p-3 text-center">
            <div className="text-xl font-bold text-[var(--foreground)]">{data.jails?.length || 0}</div>
            <div className="text-[10px] text-[var(--muted)] uppercase">Active Jails</div>
          </div>
          <div className="bg-[var(--background)] rounded-lg p-3 text-center">
            <div className={`text-xl font-bold ${totalBanned > 0 ? "text-red-500" : "text-emerald-500"}`}>{totalBanned}</div>
            <div className="text-[10px] text-[var(--muted)] uppercase">Currently Banned</div>
          </div>
          <div className="bg-[var(--background)] rounded-lg p-3 text-center">
            <div className="text-xl font-bold text-[var(--foreground)]">
              {data.jails?.reduce((s: number, j: any) => s + (j.total_banned || 0), 0) || 0}
            </div>
            <div className="text-[10px] text-[var(--muted)] uppercase">Total Bans</div>
          </div>
        </div>
      )}

      {/* Jails */}
      {data?.jails?.map((jail: any) => (
        <div key={jail.name} className="bg-[var(--background)] border border-[var(--border)] rounded-lg overflow-hidden">
          <button
            onClick={() => toggleJail(jail.name)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--card-hover)] transition-colors"
          >
            <div className="flex items-center gap-3">
              <Shield size={14} className={jail.currently_banned > 0 ? "text-red-500" : "text-emerald-500"} />
              <span className="text-sm font-medium font-mono">{jail.name}</span>
              {jail.currently_banned > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] bg-red-500/15 text-red-500 rounded-full">
                  {jail.currently_banned} banned
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--muted)]">{jail.total_failed || 0} failures</span>
              {expandedJails.has(jail.name) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </button>

          {expandedJails.has(jail.name) && (
            <div className="px-4 pb-3 border-t border-[var(--border)]">
              {/* Jail stats */}
              <div className="flex gap-4 py-2 text-xs text-[var(--muted)]">
                {jail.bantime && <span>Ban time: {jail.bantime}</span>}
                {jail.findtime && <span>Find time: {jail.findtime}</span>}
                {jail.maxretry > 0 && <span>Max retry: {jail.maxretry}</span>}
              </div>

              {/* Banned IPs */}
              {jail.banned_ips?.length > 0 ? (
                <div className="space-y-1 mt-1">
                  <div className="text-xs text-[var(--muted)] font-medium mb-1">Banned IPs:</div>
                  {jail.banned_ips.map((ip: string) => (
                    <div key={ip} className="flex items-center justify-between py-1 px-2 bg-red-500/5 rounded">
                      <span className="font-mono text-xs text-red-400">{ip}</span>
                      <button
                        onClick={() => handleUnban(jail.name, ip)}
                        disabled={actionLoading === `unban-${jail.name}-${ip}`}
                        className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-500 rounded hover:bg-emerald-500/20 flex items-center gap-1"
                      >
                        {actionLoading === `unban-${jail.name}-${ip}` ? <Loader2 size={10} className="animate-spin" /> : <Unlock size={10} />}
                        Unban
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[var(--muted)] text-center py-2">No banned IPs</div>
              )}

              {/* Ban button */}
              <button
                onClick={() => { setBanModal({ jail: jail.name }); setBanIp(""); }}
                className="mt-2 px-2 py-1 text-[10px] bg-red-500/10 text-red-500 rounded hover:bg-red-500/20 flex items-center gap-1"
              >
                <Ban size={10} /> Ban IP
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Not active */}
      {data && !data.active && (
        <div className="text-center py-8">
          <ShieldAlert size={36} className="text-[var(--muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--muted)]">Fail2ban is not running</p>
          <p className="text-xs text-[var(--muted)] mt-1">Start it to protect against brute-force attacks</p>
        </div>
      )}

      {/* Ban Modal */}
      {banModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-sm w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Ban IP in {banModal.jail}</h3>
              <button onClick={() => setBanModal(null)} className="text-[var(--muted)] hover:text-[var(--foreground)]"><X size={16} /></button>
            </div>
            <input
              value={banIp}
              onChange={e => setBanIp(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm font-mono"
              placeholder="192.168.1.100"
              pattern="^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"
            />
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setBanModal(null)} className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--muted)]">Cancel</button>
              <button
                onClick={handleBan}
                disabled={!banIp || actionLoading?.startsWith("ban-")}
                className="px-3 py-1.5 text-sm bg-red-500 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50"
              >
                {actionLoading?.startsWith("ban-") && <Loader2 size={12} className="animate-spin" />}
                <Ban size={12} /> Ban
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
