"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { authApi } from "@/lib/api";
import { useLocaleSwitch, LOCALE_LABELS, SUPPORTED_LOCALES, type Locale } from "@/i18n/client";
import {
  Server, Box, Database, Globe, Activity, Puzzle, Settings,
  ChevronLeft, ChevronRight, LogOut, User, Languages, Search
} from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";

const navKeys = [
  { icon: Server, key: "servers" as const, href: "/" },
  { icon: Box, key: "instances" as const, href: "/instances" },
  { icon: Database, key: "backups" as const, href: "/backups" },
  { icon: Globe, key: "domains" as const, href: "/domains" },
  { icon: Activity, key: "monitoring" as const, href: "/monitoring" },
  { icon: Puzzle, key: "plugins" as const, href: "/plugins" },
  { icon: Settings, key: "settings" as const, href: "/settings" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [userName, setUserName] = useState("");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const pathname = usePathname();
  const t = useTranslations("nav");
  const switchLocale = useLocaleSwitch();

  useEffect(() => {
    authApi.session().then((s) => setUserName(s.name || `ID: ${s.telegram_id}`)).catch(() => {});
  }, []);

  function handleLogout() {
    authApi.logout().finally(() => { window.location.href = "/login"; });
  }

  return (
    <>
    <aside
      className={`${collapsed ? "w-16" : "w-60"} bg-[var(--card)] border-r border-[var(--border)] flex flex-col transition-all duration-200`}
    >
      {/* Logo */}
      <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
        <div className="w-8 h-8 bg-[var(--accent)] rounded-lg flex items-center justify-center font-bold text-xs shrink-0">
          CRX
        </div>
        {!collapsed && <span className="font-semibold text-sm">{t("crxCloud")}</span>}
      </div>

      {/* Search shortcut */}
      {!collapsed && (
        <div className="px-3 pt-3 pb-1">
          <button
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-xs text-[var(--muted)] hover:border-[var(--accent)]/50 transition-colors"
          >
            <Search size={14} />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card)] border border-[var(--border)]">Ctrl+K</kbd>
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 p-2">
        {navKeys.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm mb-0.5 transition-colors ${
                isActive
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              }`}
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{t(item.key)}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Language Switcher + User + Collapse */}
      <div className="border-t border-[var(--border)]">
        {/* Language switcher */}
        {!collapsed && (
          <div className="relative px-4 py-2">
            <button
              onClick={() => setShowLangMenu(!showLangMenu)}
              className="flex items-center gap-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors w-full"
            >
              <Languages size={14} className="shrink-0" />
              <span className="truncate">
                {LOCALE_LABELS[document.cookie.match(/locale=([^;]+)/)?.[1] as Locale || "it"]}
              </span>
            </button>
            {showLangMenu && (
              <div className="absolute bottom-full left-2 mb-1 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-[160px] z-50">
                {SUPPORTED_LOCALES.map((loc) => (
                  <button
                    key={loc}
                    onClick={() => {
                      switchLocale(loc);
                      setShowLangMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--card-hover)] transition-colors flex items-center justify-between"
                  >
                    <span>{LOCALE_LABELS[loc]}</span>
                    <span className="text-[var(--muted)] text-[10px] font-mono">{loc.toUpperCase()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {userName && !collapsed && (
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <User size={14} className="text-[var(--muted)] shrink-0" />
              <span className="text-xs text-[var(--muted)] truncate">{userName}</span>
            </div>
            <button onClick={handleLogout} className="text-[var(--muted)] hover:text-[var(--danger)]">
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
    <CommandPalette />
    </>
  );
}
