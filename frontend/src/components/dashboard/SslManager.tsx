"use client";

import React, { useState, useCallback, useEffect } from "react";
import { serversApi } from "@/lib/api";
import {
  Loader2, Lock, Unlock, RefreshCw, Plus, Trash2, Download,
  CheckCircle, XCircle, AlertTriangle, ShieldCheck, Clock, X,
} from "lucide-react";

interface SslManagerProps {
  serverId: string;
  active: boolean;
}

function DaysLabel({ days }: { days: number }) {
  if (days <= 0) return <span className="text-red-500 text-xs font-medium">Expired</span>;
  if (days <= 14) return <span className="text-red-500 text-xs font-medium">{days}d remaining</span>;
  if (days <= 30) return <span className="text-yellow-500 text-xs font-medium">{days}d remaining</span>;
  return <span className="text-emerald-500 text-xs">{days}d remaining</span>;
}

export function SslManager({ serverId, active }: SslManagerProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issueForm, setIssueForm] = useState({ domain: "", email: "" });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await serversApi.sslCertificates(serverId);
      setData(result);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [serverId]);

  useEffect(() => {
    if (active) loadData();
  }, [active, loadData]);

  const handleIssue = async () => {
    if (!issueForm.domain) return;
    setActionLoading("issue");
    try {
      await serversApi.sslIssue(serverId, issueForm);
      setShowIssueModal(false);
      setIssueForm({ domain: "", email: "" });
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleRenew = async () => {
    setActionLoading("renew");
    try {
      await serversApi.sslRenew(serverId);
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleRevoke = async (domain: string) => {
    setActionLoading(`revoke-${domain}`);
    try {
      await serversApi.sslRevoke(serverId, domain);
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleInstallCertbot = async () => {
    setActionLoading("install");
    try {
      await serversApi.sslInstallCertbot(serverId);
      await loadData();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  if (loading && !data) {
    return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-[var(--accent)]" /></div>;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-2">
          <Lock size={16} /> SSL / Let&apos;s Encrypt
        </h4>
        <div className="flex items-center gap-2">
          {data?.certbot_installed && (
            <>
              <button
                onClick={handleRenew}
                disabled={actionLoading === "renew"}
                className="px-3 py-1.5 text-xs bg-[var(--accent)]/10 text-[var(--accent)] rounded-lg hover:bg-[var(--accent)]/20 flex items-center gap-1.5"
              >
                {actionLoading === "renew" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Renew All
              </button>
              <button
                onClick={() => setShowIssueModal(true)}
                className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded-lg flex items-center gap-1.5"
              >
                <Plus size={12} /> New Certificate
              </button>
            </>
          )}
          <button onClick={loadData} disabled={loading} className="p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Certbot not installed */}
      {data && !data.certbot_installed && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle size={18} className="text-yellow-500" />
            <div>
              <div className="text-sm font-medium text-yellow-500">Certbot not installed</div>
              <div className="text-xs text-[var(--muted)]">Install certbot to manage Let&apos;s Encrypt SSL certificates</div>
            </div>
          </div>
          <button
            onClick={handleInstallCertbot}
            disabled={actionLoading === "install"}
            className="px-4 py-2 bg-yellow-500 text-black rounded-lg text-sm font-medium hover:bg-yellow-400 flex items-center gap-2"
          >
            {actionLoading === "install" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Install Certbot
          </button>
        </div>
      )}

      {/* Auto-renewal status */}
      {data?.certbot_installed && (
        <div className="flex items-center gap-2 text-xs">
          {data.auto_renewal_active ? (
            <>
              <CheckCircle size={12} className="text-emerald-500" />
              <span className="text-emerald-500">Auto-renewal active</span>
            </>
          ) : (
            <>
              <XCircle size={12} className="text-yellow-500" />
              <span className="text-yellow-500">Auto-renewal inactive</span>
            </>
          )}
        </div>
      )}

      {/* Certificates list */}
      {data?.certificates?.length > 0 ? (
        <div className="space-y-2">
          {data.certificates.map((cert: any) => (
            <div
              key={cert.domain}
              className="bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 py-3 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                {cert.status === "valid" ? (
                  <ShieldCheck size={16} className="text-emerald-500" />
                ) : cert.status === "expiring_soon" ? (
                  <AlertTriangle size={16} className="text-yellow-500" />
                ) : (
                  <XCircle size={16} className="text-red-500" />
                )}
                <div>
                  <div className="text-sm font-medium font-mono">{cert.domain}</div>
                  <div className="text-xs text-[var(--muted)] flex items-center gap-3 mt-0.5">
                    <span>{cert.issuer}</span>
                    <span className="flex items-center gap-1">
                      <Clock size={10} /> Expires: {cert.expiry_date}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <DaysLabel days={cert.days_remaining} />
                <button
                  onClick={() => handleRevoke(cert.domain)}
                  disabled={actionLoading === `revoke-${cert.domain}`}
                  className="p-1 text-red-500 hover:text-red-400"
                  title="Revoke certificate"
                >
                  {actionLoading === `revoke-${cert.domain}` ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : data?.certbot_installed ? (
        <div className="text-center py-8">
          <Lock size={36} className="text-[var(--muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--muted)]">No SSL certificates found</p>
          <p className="text-xs text-[var(--muted)] mt-1">Issue a new certificate for your domains</p>
        </div>
      ) : null}

      {/* Issue Modal */}
      {showIssueModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Issue SSL Certificate</h3>
              <button onClick={() => setShowIssueModal(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-[var(--muted)]">Domain</label>
                <input
                  value={issueForm.domain}
                  onChange={e => setIssueForm(f => ({ ...f, domain: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm font-mono"
                  placeholder="example.com"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--muted)]">Email (optional, for Let&apos;s Encrypt notifications)</label>
                <input
                  value={issueForm.email}
                  onChange={e => setIssueForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded-lg text-sm"
                  placeholder="admin@example.com"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6">
              <button onClick={() => setShowIssueModal(false)} className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] text-[var(--muted)]">Cancel</button>
              <button
                onClick={handleIssue}
                disabled={!issueForm.domain || actionLoading === "issue"}
                className="px-4 py-2 text-sm bg-[var(--accent)] text-white rounded-lg flex items-center gap-2 disabled:opacity-50"
              >
                {actionLoading === "issue" && <Loader2 size={14} className="animate-spin" />}
                Issue Certificate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
