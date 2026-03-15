"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { instancesApi } from "@/lib/api";
import {
  Globe, ExternalLink, RefreshCw, Shield, ShieldOff, Box
} from "lucide-react";

interface DomainEntry {
  instanceId: string;
  instanceName: string;
  domain: string;
  url: string;
  status: string;
  cmsType: string;
}

export default function DomainsPage() {
  const router = useRouter();
  const t = useTranslations("domains");
  const tc = useTranslations("common");
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const instances = await instancesApi.list().catch(() => []);
      const entries: DomainEntry[] = instances
        .filter((i: any) => i.domain)
        .map((i: any) => ({
          instanceId: i.id,
          instanceName: i.name,
          domain: i.domain,
          url: i.url || `http://${i.domain}`,
          status: i.status,
          cmsType: i.cms_type,
        }));
      setDomains(entries);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">{t("title")}</h1>
                <button onClick={loadData} className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                  <RefreshCw size={16} />
                </button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              ) : domains.length === 0 ? (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                  <Globe size={48} className="mx-auto text-[var(--muted)] mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{t("emptyTitle")}</h3>
                  <p className="text-sm text-[var(--muted)] mb-4">
                    {t("emptyDescription")}
                  </p>
                  <button
                    onClick={() => router.push("/instances")}
                    className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium"
                  >
                    {t("goToInstances")}
                  </button>
                </div>
              ) : (
                <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                        <th className="text-left px-4 py-3">{t("domain")}</th>
                        <th className="text-left px-4 py-3">{t("instance")}</th>
                        <th className="text-left px-4 py-3">{t("cms")}</th>
                        <th className="text-left px-4 py-3">{t("ssl")}</th>
                        <th className="text-left px-4 py-3">{tc("status")}</th>
                        <th className="text-right px-4 py-3">{tc("actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {domains.map((d) => {
                        const isHttps = d.url.startsWith("https://");
                        return (
                          <tr key={d.instanceId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <Globe size={14} className="text-[var(--accent)]" />
                                <span className="text-sm font-medium">{d.domain}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => router.push(`/instances/${d.instanceId}`)}
                                className="text-sm text-[var(--accent)] hover:underline flex items-center gap-1"
                              >
                                <Box size={12} /> {d.instanceName}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-sm text-[var(--muted)] capitalize">{d.cmsType}</td>
                            <td className="px-4 py-3">
                              {isHttps ? (
                                <span className="flex items-center gap-1 text-xs text-[var(--success)]">
                                  <Shield size={12} /> {t("sslActive")}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-xs text-[var(--warning)]">
                                  <ShieldOff size={12} /> {t("sslPending")}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs capitalize ${
                                d.status === "running" ? "text-[var(--success)]" :
                                d.status === "stopped" ? "text-[var(--muted)]" :
                                "text-[var(--warning)]"
                              }`}>
                                {d.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <a
                                href={d.url}
                                target="_blank"
                                rel="noopener"
                                className="text-xs px-3 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors inline-flex items-center gap-1"
                              >
                                <ExternalLink size={12} /> {tc("visit")}
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Info box */}
              <div className="mt-6 bg-[var(--card)] border border-[var(--border)] rounded-xl p-5">
                <h3 className="text-sm font-semibold mb-2">{t("setup.title")}</h3>
                <div className="text-sm text-[var(--muted)] space-y-1">
                  <p>{t("setup.step1")}</p>
                  <p>{t("setup.step2")}</p>
                  <p>{t("setup.step3")}</p>
                  <p>{t("setup.step4")}</p>
                </div>
              </div>
            </div>
          </main>
          <VitoChat />
        </div>
      </div>
    </AuthGuard>
  );
}
