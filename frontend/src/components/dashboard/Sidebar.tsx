"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { getUser, logout } from "@/lib/auth";
import {
  Server, Box, Database, Globe, Activity, Puzzle,
  ChevronLeft, ChevronRight, LogOut, User
} from "lucide-react";

const navItems = [
  { icon: Server, label: "Servers", href: "/" },
  { icon: Box, label: "Instances", href: "/instances" },
  { icon: Database, label: "Backups", href: "/backups" },
  { icon: Globe, label: "Domains", href: "/domains" },
  { icon: Activity, label: "Monitoring", href: "/monitoring" },
  { icon: Puzzle, label: "Plugins", href: "/plugins" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const user = getUser();

  return (
    <aside
      className={`${collapsed ? "w-16" : "w-60"} bg-[var(--card)] border-r border-[var(--border)] flex flex-col transition-all duration-200`}
    >
      {/* Logo */}
      <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
        <div className="w-8 h-8 bg-[var(--accent)] rounded-lg flex items-center justify-center font-bold text-xs shrink-0">
          CRX
        </div>
        {!collapsed && <span className="font-semibold text-sm">CRX Cloud</span>}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-colors ${
                isActive
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              }`}
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* User + Collapse */}
      <div className="border-t border-[var(--border)]">
        {user && !collapsed && (
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <User size={14} className="text-[var(--muted)] shrink-0" />
              <span className="text-xs text-[var(--muted)] truncate">{user.email}</span>
            </div>
            <button onClick={logout} className="text-[var(--muted)] hover:text-[var(--danger)]">
              <LogOut size={14} />
            </button>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full p-3 text-[var(--muted)] hover:text-[var(--foreground)] text-xs flex items-center justify-center"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
    </aside>
  );
}
