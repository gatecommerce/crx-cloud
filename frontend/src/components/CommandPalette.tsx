"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Search,
  LayoutDashboard,
  Server,
  Box,
  HardDrive,
  Activity,
  Globe,
  Settings2,
  Plus,
  RotateCcw,
  RefreshCw,
  Clock,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CommandPaletteProps {
  servers?: Array<{ id: string; name: string; endpoint: string; status: string }>;
  instances?: Array<{ id: string; name: string; cms_type: string; status: string; server_name?: string }>;
}

interface CommandItem {
  id: string;
  label: string;
  category: string;
  icon: React.ElementType;
  action: () => void;
  keywords?: string;
  subtitle?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const RECENT_KEY = "crx-command-palette-recent";
const MAX_RECENT = 5;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Simple fuzzy match — checks that all query chars appear in order. */
function fuzzyMatch(text: string, query: string): { match: boolean; score: number } {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return { match: true, score: 0 };

  let qi = 0;
  let score = 0;
  let lastIdx = -1;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      score += lastIdx === i - 1 ? 2 : 1; // consecutive bonus
      lastIdx = i;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

/** Highlight matching characters in label. */
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;

  const q = query.toLowerCase();
  const chars = text.split("");
  const highlighted: boolean[] = new Array(chars.length).fill(false);

  let qi = 0;
  for (let i = 0; i < chars.length && qi < q.length; i++) {
    if (chars[i].toLowerCase() === q[qi]) {
      highlighted[i] = true;
      qi++;
    }
  }

  return (
    <>
      {chars.map((ch, i) =>
        highlighted[i] ? (
          <span key={i} className="text-[var(--accent)] font-semibold">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Recent pages (localStorage)                                        */
/* ------------------------------------------------------------------ */

function loadRecent(): Array<{ path: string; label: string }> {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushRecent(path: string, label: string) {
  if (typeof window === "undefined") return;
  try {
    let items = loadRecent().filter((r) => r.path !== path);
    items.unshift({ path, label });
    items = items.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CommandPalette({ servers = [], instances = [] }: CommandPaletteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentPages, setRecentPages] = useState<Array<{ path: string; label: string }>>([]);
  const [animating, setAnimating] = useState(false);

  /* i18n with fallback */
  const t = useTranslations("commandPalette");
  const label = useCallback(
    (key: string, fallback: string): string => {
      try {
        const v = t(key);
        // next-intl returns the key path itself when missing in some setups
        return v === key || v === `commandPalette.${key}` ? fallback : v;
      } catch {
        return fallback;
      }
    },
    [t]
  );

  /* ---- Build command items ---- */
  const items: CommandItem[] = useMemo(() => {
    const nav = (path: string, lbl: string) => () => {
      pushRecent(path, lbl);
      router.push(path);
    };

    const list: CommandItem[] = [
      /* Navigation */
      { id: "nav-dashboard", label: label("dashboard", "Dashboard"), category: label("catNavigation", "Navigation"), icon: LayoutDashboard, action: nav("/", "Dashboard") },
      { id: "nav-servers", label: label("servers", "Servers"), category: label("catNavigation", "Navigation"), icon: Server, action: nav("/", "Servers") },
      { id: "nav-instances", label: label("instances", "Instances"), category: label("catNavigation", "Navigation"), icon: Box, action: nav("/instances", "Instances") },
      { id: "nav-backups", label: label("backups", "Backups"), category: label("catNavigation", "Navigation"), icon: HardDrive, action: nav("/backups", "Backups") },
      { id: "nav-monitoring", label: label("monitoring", "Monitoring"), category: label("catNavigation", "Navigation"), icon: Activity, action: nav("/monitoring", "Monitoring") },
      { id: "nav-domains", label: label("domains", "Domains"), category: label("catNavigation", "Navigation"), icon: Globe, action: nav("/domains", "Domains") },
      { id: "nav-settings", label: label("settings", "Settings"), category: label("catNavigation", "Navigation"), icon: Settings2, action: nav("/settings", "Settings") },

      /* Server Actions */
      { id: "act-reboot", label: label("rebootServer", "Reboot Server"), category: label("catServerActions", "Server Actions"), icon: RotateCcw, action: nav("/", "Servers"), keywords: "restart power" },
      { id: "act-refresh", label: label("refreshSpecs", "Refresh Specs"), category: label("catServerActions", "Server Actions"), icon: RefreshCw, action: nav("/", "Servers"), keywords: "reload update" },

      /* Quick Actions */
      { id: "quick-server", label: label("createServer", "Create Server"), category: label("catQuickActions", "Quick Actions"), icon: Plus, action: nav("/?action=create-server", "Create Server"), keywords: "new add provision" },
      { id: "quick-instance", label: label("createInstance", "Create Instance"), category: label("catQuickActions", "Quick Actions"), icon: Plus, action: nav("/instances?action=create", "Create Instance"), keywords: "new add deploy cms" },
      { id: "quick-backup", label: label("createBackup", "Create Backup"), category: label("catQuickActions", "Quick Actions"), icon: Plus, action: nav("/backups?action=create", "Create Backup"), keywords: "new add snapshot" },
    ];

    /* Dynamic servers */
    for (const srv of servers) {
      list.push({
        id: `srv-${srv.id}`,
        label: srv.name,
        category: label("catServers", "Servers"),
        icon: Server,
        subtitle: `${srv.endpoint} — ${srv.status}`,
        action: nav(`/?server=${srv.id}`, srv.name),
        keywords: `${srv.endpoint} ${srv.status}`,
      });
    }

    /* Dynamic instances */
    for (const inst of instances) {
      list.push({
        id: `inst-${inst.id}`,
        label: inst.name,
        category: label("catInstances", "Instances"),
        icon: Box,
        subtitle: `${inst.cms_type}${inst.server_name ? ` on ${inst.server_name}` : ""} — ${inst.status}`,
        action: nav(`/instances?instance=${inst.id}`, inst.name),
        keywords: `${inst.cms_type} ${inst.server_name ?? ""} ${inst.status}`,
      });
    }

    /* Recent pages */
    for (const r of recentPages) {
      if (r.path === pathname) continue; // skip current page
      list.push({
        id: `recent-${r.path}`,
        label: r.label,
        category: label("catRecent", "Recent"),
        icon: Clock,
        action: nav(r.path, r.label),
      });
    }

    return list;
  }, [servers, instances, recentPages, pathname, router, label]);

  /* ---- Filtered + scored results ---- */
  const filtered = useMemo(() => {
    if (!query.trim()) return items;

    return items
      .map((item) => {
        const labelResult = fuzzyMatch(item.label, query);
        const kwResult = item.keywords ? fuzzyMatch(item.keywords, query) : { match: false, score: 0 };
        const catResult = fuzzyMatch(item.category, query);
        const subResult = item.subtitle ? fuzzyMatch(item.subtitle, query) : { match: false, score: 0 };

        const best = Math.max(
          labelResult.match ? labelResult.score : 0,
          kwResult.match ? kwResult.score : 0,
          catResult.match ? catResult.score : 0,
          subResult.match ? subResult.score : 0
        );
        const match = labelResult.match || kwResult.match || catResult.match || subResult.match;

        return { item, match, score: best };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.item);
  }, [items, query]);

  /* Group by category preserving order */
  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const cat = item.category;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return map;
  }, [filtered]);

  /* ---- Open / close helpers ---- */
  const openPalette = useCallback(() => {
    setRecentPages(loadRecent());
    setQuery("");
    setSelectedIndex(0);
    setOpen(true);
    setAnimating(true);
    requestAnimationFrame(() => setAnimating(false));
  }, []);

  const closePalette = useCallback(() => {
    setAnimating(true);
    setTimeout(() => {
      setOpen(false);
      setAnimating(false);
    }, 150);
  }, []);

  /* ---- Global keyboard shortcut (Ctrl/Cmd + K) ---- */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) {
          closePalette();
        } else {
          openPalette();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, openPalette, closePalette]);

  /* ---- Auto-focus input on open ---- */
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* ---- Reset selected index when query changes ---- */
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  /* ---- Keyboard navigation inside palette ---- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[selectedIndex];
        if (item) {
          item.action();
          closePalette();
        }
      }
    },
    [filtered, selectedIndex, closePalette]
  );

  /* ---- Scroll selected item into view ---- */
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  /* ---- Don't render if closed ---- */
  if (!open) return null;

  /* ---- Flat index counter for rendering ---- */
  let flatIndex = 0;

  const isVisible = open && !animating;

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] transition-all duration-150"
      style={{
        backgroundColor: isVisible ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0)",
        backdropFilter: isVisible ? "blur(4px)" : "blur(0px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      {/* Modal */}
      <div
        className="w-full max-w-[560px] mx-4 rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl overflow-hidden transition-all duration-150"
        style={{
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? "scale(1) translateY(0)" : "scale(0.96) translateY(-8px)",
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search size={18} className="text-[var(--muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={label("searchPlaceholder", "Search commands...")}
            className="flex-1 bg-transparent text-[var(--foreground)] text-sm outline-none placeholder:text-[var(--muted)]"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted)]">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto overscroll-contain py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--muted)]">
              {label("noResults", "No results found.")}
            </div>
          ) : (
            Array.from(grouped.entries()).map(([category, catItems]) => (
              <div key={category}>
                {/* Category header */}
                <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  {category}
                </div>

                {catItems.map((item) => {
                  const idx = flatIndex++;
                  const isSelected = idx === selectedIndex;
                  const Icon = item.icon;

                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      onClick={() => {
                        item.action();
                        closePalette();
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-75 cursor-pointer ${
                        isSelected
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--foreground)] hover:bg-[var(--background)]"
                      }`}
                    >
                      <Icon
                        size={16}
                        className={`shrink-0 ${isSelected ? "text-white" : "text-[var(--muted)]"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">
                          {isSelected ? item.label : <HighlightMatch text={item.label} query={query} />}
                        </div>
                        {item.subtitle && (
                          <div
                            className={`text-xs truncate mt-0.5 ${
                              isSelected ? "text-white/70" : "text-[var(--muted)]"
                            }`}
                          >
                            {item.subtitle}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <span className="text-[10px] text-white/60 shrink-0 hidden sm:block">
                          {label("enterToSelect", "Enter to select")}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--border)] text-[10px] text-[var(--muted)]">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 font-mono">
              &uarr;&darr;
            </kbd>
            {label("navigate", "navigate")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 font-mono">
              &crarr;
            </kbd>
            {label("select", "select")}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 font-mono">
              esc
            </kbd>
            {label("close", "close")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 font-mono">
              Ctrl K
            </kbd>
            {label("toggle", "toggle")}
          </span>
        </div>
      </div>
    </div>
  );
}
