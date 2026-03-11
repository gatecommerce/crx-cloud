"use client";

import { useState } from "react";

const navItems = [
  { icon: "S", label: "Servers", href: "/", active: true },
  { icon: "I", label: "Instances", href: "/instances" },
  { icon: "B", label: "Backups", href: "/backups" },
  { icon: "D", label: "Domains", href: "/domains" },
  { icon: "M", label: "Monitoring", href: "/monitoring" },
  { icon: "P", label: "Plugins", href: "/plugins" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`${collapsed ? "w-16" : "w-60"} bg-[var(--card)] border-r border-[var(--border)] flex flex-col transition-all duration-200`}
    >
      {/* Logo */}
      <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
        <div className="w-8 h-8 bg-[var(--accent)] rounded-lg flex items-center justify-center font-bold text-sm">
          CRX
        </div>
        {!collapsed && <span className="font-semibold text-sm">CRX Cloud</span>}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2">
        {navItems.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-colors ${
              item.active
                ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
            }`}
          >
            <span className="w-5 text-center font-mono">{item.icon}</span>
            {!collapsed && <span>{item.label}</span>}
          </a>
        ))}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="p-4 border-t border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] text-xs"
      >
        {collapsed ? ">>" : "<< Collapse"}
      </button>
    </aside>
  );
}
