/**
 * CRX Cloud — Enterprise Log Viewer Types & Utilities
 *
 * Shared types, severity colors, and parsing utilities for the log viewer system.
 */

// ─── Log Severity Levels ───────────────────────────────────────

export type LogLevel = "critical" | "error" | "warning" | "info" | "debug" | "trace" | "unknown";

export const LOG_LEVELS: LogLevel[] = ["critical", "error", "warning", "info", "debug", "trace", "unknown"];

// ─── Log Entry (matches backend LogEntry) ──────────────────────

export interface LogEntry {
  line_number: number;
  raw: string;
  level: LogLevel;
  timestamp: string | null;
  logger_name: string | null;
  message: string;
  pid: number | null;
  database: string | null;
  is_traceback: boolean;
  traceback_group_id: number | null;
  is_sql: boolean;
  container: string;
}

// ─── WebSocket Message Types ───────────────────────────────────

export interface WsConnected {
  type: "connected";
  instance_id: string;
  instance_name: string;
  container: string;
  available_containers: string[];
  initial_lines: number;
}

export interface WsLogMessage {
  type: "log";
  entries: LogEntry[];
}

export interface WsStatsMessage {
  type: "stats";
  stats: Record<LogLevel, number>;
  total_lines: number;
  buffer_size: number;
  connected_seconds: number;
  paused: boolean;
}

export interface WsHistoryMessage {
  type: "history";
  entries: LogEntry[];
  total_buffered: number;
}

export interface WsErrorMessage {
  type: "error";
  message: string;
}

export interface WsContainerChanged {
  type: "container_changed";
  container: string;
  available: string[];
}

export type WsMessage =
  | WsConnected
  | WsLogMessage
  | WsStatsMessage
  | WsHistoryMessage
  | WsErrorMessage
  | WsContainerChanged
  | { type: "paused"; pending: number }
  | { type: "resumed" }
  | { type: "cleared" };

// ─── Client Commands ───────────────────────────────────────────

export type WsCommand =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "container"; name: string }
  | { action: "history"; count?: number }
  | { action: "stats" }
  | { action: "clear" };

// ─── Filter State ──────────────────────────────────────────────

export interface LogFilters {
  levels: Set<LogLevel>;
  search: string;
  searchRegex: boolean;
  container: string;
  logger: string;
  showTraceback: boolean;
}

export const DEFAULT_FILTERS: LogFilters = {
  levels: new Set(LOG_LEVELS),
  search: "",
  searchRegex: false,
  container: "",
  logger: "",
  showTraceback: true,
};

// ─── Severity Color Scheme ─────────────────────────────────────

export interface SeverityTheme {
  text: string;       // Tailwind text color
  bg: string;         // Tailwind bg color (subtle)
  badge: string;      // Badge bg color
  badgeText: string;  // Badge text color
  border: string;     // Left border color
  dot: string;        // Dot/indicator color
  icon: string;       // Icon color
}

export const SEVERITY_COLORS: Record<LogLevel, SeverityTheme> = {
  critical: {
    text: "text-red-300",
    bg: "bg-red-500/8",
    badge: "bg-red-500/20",
    badgeText: "text-red-400",
    border: "border-l-red-500",
    dot: "bg-red-500",
    icon: "text-red-400",
  },
  error: {
    text: "text-red-400",
    bg: "bg-red-500/5",
    badge: "bg-red-500/15",
    badgeText: "text-red-400",
    border: "border-l-red-400",
    dot: "bg-red-400",
    icon: "text-red-400",
  },
  warning: {
    text: "text-amber-400",
    bg: "bg-amber-500/5",
    badge: "bg-amber-500/15",
    badgeText: "text-amber-400",
    border: "border-l-amber-400",
    dot: "bg-amber-400",
    icon: "text-amber-400",
  },
  info: {
    text: "text-blue-400",
    bg: "bg-transparent",
    badge: "bg-blue-500/15",
    badgeText: "text-blue-400",
    border: "border-l-blue-400/30",
    dot: "bg-blue-400",
    icon: "text-blue-400",
  },
  debug: {
    text: "text-gray-500",
    bg: "bg-transparent",
    badge: "bg-gray-500/15",
    badgeText: "text-gray-500",
    border: "border-l-gray-600/30",
    dot: "bg-gray-500",
    icon: "text-gray-500",
  },
  trace: {
    text: "text-gray-600",
    bg: "bg-transparent",
    badge: "bg-gray-600/15",
    badgeText: "text-gray-600",
    border: "border-l-gray-700/30",
    dot: "bg-gray-600",
    icon: "text-gray-600",
  },
  unknown: {
    text: "text-gray-400",
    bg: "bg-transparent",
    badge: "bg-gray-500/10",
    badgeText: "text-gray-500",
    border: "border-l-gray-700/20",
    dot: "bg-gray-500",
    icon: "text-gray-500",
  },
};

// ─── Utility Functions ─────────────────────────────────────────

export function levelLabel(level: LogLevel): string {
  const labels: Record<LogLevel, string> = {
    critical: "CRIT",
    error: "ERROR",
    warning: "WARN",
    info: "INFO",
    debug: "DEBUG",
    trace: "TRACE",
    unknown: "—",
  };
  return labels[level];
}

export function formatTimestamp(ts: string | null): string {
  if (!ts) return "";
  try {
    // Try to parse and return HH:MM:SS.mmm
    const clean = ts.replace(",", ".");
    const match = clean.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (match) return match[1];
    // Fallback: try Date parsing
    const d = new Date(clean);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
    }
  } catch {}
  return ts;
}

export function formatRelativeTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function matchesFilter(entry: LogEntry, filters: LogFilters): boolean {
  // Level filter
  if (!filters.levels.has(entry.level)) return false;

  // Container filter
  if (filters.container && entry.container !== filters.container) return false;

  // Logger filter
  if (filters.logger && entry.logger_name && !entry.logger_name.includes(filters.logger)) return false;

  // Traceback filter
  if (!filters.showTraceback && entry.is_traceback) return false;

  // Search filter
  if (filters.search) {
    if (filters.searchRegex) {
      try {
        const re = new RegExp(filters.search, "i");
        if (!re.test(entry.raw)) return false;
      } catch {
        // Invalid regex — treat as literal
        if (!entry.raw.toLowerCase().includes(filters.search.toLowerCase())) return false;
      }
    } else {
      if (!entry.raw.toLowerCase().includes(filters.search.toLowerCase())) return false;
    }
  }

  return true;
}

/** Highlight search matches in a log line. Returns array of segments. */
export function highlightMatches(
  text: string,
  search: string,
  isRegex: boolean,
): { text: string; highlight: boolean }[] {
  if (!search) return [{ text, highlight: false }];

  try {
    const re = isRegex ? new RegExp(`(${search})`, "gi") : new RegExp(`(${escapeRegex(search)})`, "gi");
    const parts = text.split(re);
    return parts.map((part, i) => ({
      text: part,
      highlight: i % 2 === 1,
    }));
  } catch {
    return [{ text, highlight: false }];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract unique logger names from entries. */
export function extractLoggers(entries: LogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.logger_name) set.add(e.logger_name);
  }
  return Array.from(set).sort();
}
