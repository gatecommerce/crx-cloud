"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { Activity } from "lucide-react";

export default function MonitoringPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              <h1 className="text-2xl font-bold mb-6">Monitoring</h1>
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-12 text-center">
                <Activity size={48} className="mx-auto text-[var(--muted)] mb-4" />
                <h3 className="text-lg font-semibold mb-2">Coming Soon</h3>
                <p className="text-sm text-[var(--muted)]">
                  Real-time resource monitoring with CPU, RAM, disk charts, alerts and log streaming.
                </p>
              </div>
            </div>
          </main>
          <VitoChat />
        </div>
      </div>
    </AuthGuard>
  );
}
