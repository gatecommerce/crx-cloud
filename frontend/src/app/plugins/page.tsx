"use client";

import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { Puzzle, Check } from "lucide-react";

const plugins = [
  {
    id: "odoo",
    name: "Odoo",
    description: "Complete ERP & CMS platform. Community and Enterprise editions.",
    versions: ["19.0", "18.0", "17.0", "16.0"],
    available: true,
    color: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  },
  {
    id: "wordpress",
    name: "WordPress",
    description: "The world's most popular CMS. Blogs, sites, e-commerce.",
    versions: ["6.8", "6.7", "6.6"],
    available: false,
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  {
    id: "prestashop",
    name: "PrestaShop",
    description: "Open-source e-commerce platform. EU-focused, multi-language.",
    versions: ["9.0", "8.2", "8.1"],
    available: false,
    color: "bg-pink-500/10 text-pink-400 border-pink-500/20",
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    description: "WordPress e-commerce plugin. Flexible and extensible.",
    versions: ["6.8", "6.7"],
    available: false,
    color: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  },
];

export default function PluginsPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-7xl mx-auto">
              <h1 className="text-2xl font-bold mb-6">Plugins</h1>
              <div className="grid gap-4 md:grid-cols-2">
                {plugins.map((plugin) => (
                  <div
                    key={plugin.id}
                    className={`bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 ${
                      plugin.available ? "hover:border-[var(--accent)]/30" : "opacity-60"
                    } transition-colors`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold border ${plugin.color}`}>
                          {plugin.name.charAt(0)}
                        </div>
                        <div>
                          <h3 className="font-semibold">{plugin.name}</h3>
                          <span className="text-xs text-[var(--muted)]">
                            {plugin.versions.join(", ")}
                          </span>
                        </div>
                      </div>
                      {plugin.available ? (
                        <span className="flex items-center gap-1 text-xs text-[var(--success)]">
                          <Check size={14} /> Active
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--muted)]">Coming soon</span>
                      )}
                    </div>
                    <p className="text-sm text-[var(--muted)]">{plugin.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </main>
          <VitoChat />
        </div>
      </div>
    </AuthGuard>
  );
}
