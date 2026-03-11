"use client";

import { useEffect, useState } from "react";
import { serversApi, instancesApi, backupsApi } from "@/lib/api";
import { Server, Box, Database, AlertTriangle } from "lucide-react";

interface Stats {
  servers: number;
  instances: number;
  backups: number;
  alerts: number;
}

export function StatsBar() {
  const [stats, setStats] = useState<Stats>({ servers: 0, instances: 0, backups: 0, alerts: 0 });

  useEffect(() => {
    async function load() {
      try {
        const [servers, instances, backups] = await Promise.all([
          serversApi.list().catch(() => []),
          instancesApi.list().catch(() => []),
          backupsApi.list().catch(() => []),
        ]);
        const errorCount = [
          ...servers.filter((s: any) => s.status === "error"),
          ...instances.filter((i: any) => i.status === "error"),
        ].length;
        setStats({
          servers: servers.length,
          instances: instances.length,
          backups: backups.length,
          alerts: errorCount,
        });
      } catch {
        // keep defaults
      }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const items = [
    { icon: Server, label: "Servers", value: stats.servers, ok: true },
    { icon: Box, label: "Instances", value: stats.instances, ok: true },
    { icon: Database, label: "Backups", value: stats.backups, ok: true },
    { icon: AlertTriangle, label: "Alerts", value: stats.alerts, ok: stats.alerts === 0 },
  ];

  return (
    <header className="border-b border-[var(--border)] bg-[var(--card)] px-6 py-3">
      <div className="flex items-center gap-8">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="flex items-center gap-2">
              <Icon size={14} className={item.ok ? "text-[var(--success)]" : "text-[var(--warning)]"} />
              <span className="text-sm text-[var(--muted)]">{item.label}</span>
              <span className="text-sm font-semibold">{item.value}</span>
            </div>
          );
        })}
        <div className="ml-auto text-xs text-[var(--muted)]">cloud.crx.team</div>
      </div>
    </header>
  );
}
