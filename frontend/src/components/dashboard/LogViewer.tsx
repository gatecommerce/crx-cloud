"use client";

/**
 * CRX Cloud — Enterprise Log Viewer
 *
 * Features:
 * - HTTP polling with client-side parsing (always works)
 * - Severity color coding & badges
 * - Multi-level filtering (severity chips, search, regex, logger)
 * - Pause/Resume polling
 * - Local clear (instant, no server dependency)
 * - Copy, Download
 * - Traceback grouping (collapsible)
 * - Keyboard shortcuts
 * - Stats bar with live counters
 * - Fullscreen mode
 * - Configurable line count
 * - Auto-scroll with "new lines" indicator
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Search, X, Download, Copy, Trash2, Pause, Play,
  Maximize2, Minimize2, ChevronDown, ChevronRight,
  WifiOff, RefreshCw, Filter, Regex, Terminal,
  ArrowDown, Bookmark, ScrollText,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useLogStream, type ConnectionState } from "@/lib/use-log-stream";
import {
  type LogEntry,
  type LogLevel,
  type LogFilters,
  LOG_LEVELS,
  SEVERITY_COLORS,
  DEFAULT_FILTERS,
  levelLabel,
  formatTimestamp,
  formatRelativeTime,
  matchesFilter,
  highlightMatches,
  extractLoggers,
} from "@/lib/log-types";

// ─── Props ─────────────────────────────────────────────────────

interface LogViewerProps {
  instanceId?: string;
  logUrl?: string;
  active?: boolean;
  extraToolbar?: React.ReactNode;
  title?: string;
}

// ─── Status Indicator ──────────────────────────────────────────

function ConnectionStatus({ status, onReconnect, onRefresh, labels }: {
  status: ConnectionState;
  onReconnect: () => void;
  onRefresh: () => void;
  labels: {
    statusLive: string;
    statusLoading: string;
    statusPolling: string;
    statusDisconnected: string;
    statusError: string;
    refreshNow: string;
    retry: string;
  };
}) {
  const config: Record<ConnectionState, { color: string; label: string; pulse: boolean }> = {
    connected: { color: "bg-emerald-500", label: labels.statusLive, pulse: true },
    connecting: { color: "bg-amber-500", label: labels.statusLoading, pulse: true },
    polling: { color: "bg-emerald-500", label: labels.statusPolling, pulse: true },
    disconnected: { color: "bg-gray-500", label: labels.statusDisconnected, pulse: false },
    error: { color: "bg-red-500", label: labels.statusError, pulse: false },
  };
  const c = config[status];

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex items-center gap-1.5">
        {c.pulse && (
          <span className={`absolute inline-flex h-2.5 w-2.5 rounded-full ${c.color} opacity-75 animate-ping`} />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${c.color}`} />
        <span className="text-xs text-gray-400">{c.label}</span>
      </div>
      <button
        onClick={onRefresh}
        className="text-gray-500 hover:text-gray-300 transition-colors"
        title={labels.refreshNow}
      >
        <RefreshCw size={12} />
      </button>
      {(status === "disconnected" || status === "error") && (
        <button
          onClick={onReconnect}
          className="text-xs text-blue-400 hover:text-blue-300"
          title={labels.refreshNow}
        >
          {labels.retry}
        </button>
      )}
    </div>
  );
}

// ─── Severity Badge ────────────────────────────────────────────

function SeverityBadge({ level }: { level: LogLevel }) {
  const theme = SEVERITY_COLORS[level];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tracking-wider ${theme.badge} ${theme.badgeText}`}>
      {levelLabel(level)}
    </span>
  );
}

// ─── Severity Filter Chips ─────────────────────────────────────

function SeverityChips({
  activeLevels,
  stats,
  onToggle,
}: {
  activeLevels: Set<LogLevel>;
  stats: Record<string, number>;
  onToggle: (level: LogLevel) => void;
}) {
  // Show all levels that have entries, plus the main ones
  const displayLevels: LogLevel[] = ["critical", "error", "warning", "info", "debug", "unknown"];

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {displayLevels.map((level) => {
        const theme = SEVERITY_COLORS[level];
        const active = activeLevels.has(level);
        const count = stats[level] || 0;

        // Hide levels with 0 entries (except error/warning/info)
        if (count === 0 && !["error", "warning", "info"].includes(level)) return null;

        return (
          <button
            key={level}
            onClick={() => onToggle(level)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all border ${
              active
                ? `${theme.badge} ${theme.badgeText} border-current/20`
                : "bg-transparent text-gray-600 border-transparent hover:text-gray-400"
            }`}
            title={`${active ? "Hide" : "Show"} ${level} logs (${count})`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${active ? theme.dot : "bg-gray-700"}`} />
            {levelLabel(level)}
            {count > 0 && (
              <span className={`ml-0.5 px-1 rounded text-[9px] ${active ? "bg-white/10" : "bg-gray-800"}`}>
                {count > 999 ? `${(count / 1000).toFixed(1)}k` : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Log Line Component ────────────────────────────────────────

const LogLine = React.memo(function LogLine({
  entry,
  searchTerm,
  searchRegex,
  isBookmarked,
  onBookmark,
  showTimestamp,
  isTracebackCollapsed,
  isTracebackHead,
  tracebackCount,
  onToggleTraceback,
  labels,
}: {
  entry: LogEntry;
  searchTerm: string;
  searchRegex: boolean;
  isBookmarked: boolean;
  onBookmark: (lineNum: number) => void;
  showTimestamp: boolean;
  isTracebackCollapsed: boolean;
  isTracebackHead: boolean;
  tracebackCount: number;
  onToggleTraceback: (groupId: number) => void;
  labels: {
    removeBookmark: string;
    bookmarkLine: string;
    expandTraceback: (count: number) => string;
    collapseTraceback: string;
    linesCollapsed: (count: number) => string;
  };
}) {
  const theme = SEVERITY_COLORS[entry.level];
  const segments = highlightMatches(entry.raw, searchTerm, searchRegex);

  return (
    <div
      className={`group flex items-start font-mono text-[12px] leading-[20px] border-l-2 ${theme.border} ${theme.bg} hover:bg-white/[0.03] transition-colors`}
      id={`L${entry.line_number}`}
    >
      {/* Line number */}
      <button
        onClick={() => onBookmark(entry.line_number)}
        className={`flex-shrink-0 w-[52px] text-right pr-3 select-none transition-colors ${
          isBookmarked
            ? "text-amber-400 bg-amber-500/10"
            : "text-gray-600 hover:text-gray-400"
        }`}
        title={isBookmarked ? labels.removeBookmark : labels.bookmarkLine}
      >
        {isBookmarked ? (
          <Bookmark size={10} className="inline mr-0.5" />
        ) : null}
        {entry.line_number}
      </button>

      {/* Timestamp */}
      {showTimestamp && entry.timestamp && (
        <span className="flex-shrink-0 w-[100px] text-gray-600 text-[11px] pr-2 select-none truncate">
          {formatTimestamp(entry.timestamp)}
        </span>
      )}

      {/* Severity badge */}
      <span className="flex-shrink-0 w-[52px] pr-2">
        <SeverityBadge level={entry.level} />
      </span>

      {/* Traceback toggle */}
      {entry.is_traceback && isTracebackHead ? (
        <button
          onClick={() => entry.traceback_group_id !== null && onToggleTraceback(entry.traceback_group_id)}
          className="flex-shrink-0 w-5 text-gray-500 hover:text-gray-300 transition-colors"
          title={isTracebackCollapsed ? labels.expandTraceback(tracebackCount) : labels.collapseTraceback}
        >
          {isTracebackCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : (
        <span className="flex-shrink-0 w-5" />
      )}

      {/* Log message */}
      <span className={`flex-1 min-w-0 break-all ${theme.text} ${entry.is_traceback && !isTracebackHead ? "pl-2 opacity-80" : ""}`}>
        {segments.map((seg, i) => (
          seg.highlight ? (
            <mark key={i} className="bg-amber-500/30 text-amber-200 rounded px-0.5">
              {seg.text}
            </mark>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        ))}
        {entry.is_traceback && isTracebackHead && isTracebackCollapsed && tracebackCount > 1 && (
          <span className="ml-2 text-gray-600 text-[10px]">
            {labels.linesCollapsed(tracebackCount)}
          </span>
        )}
      </span>
    </div>
  );
});

// ─── Stats Bar ─────────────────────────────────────────────────

function StatsFooter({
  stats,
  totalLines,
  filteredCount,
  connectedSeconds,
  paused,
  labels,
}: {
  stats: Record<string, number>;
  totalLines: number;
  filteredCount: number;
  connectedSeconds: number;
  paused: boolean;
  labels: {
    linesCount: string;
    filtered: string;
    errorsCount: string;
    warnCount: string;
    paused: string;
  };
}) {
  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[#161b22] border-t border-[#30363d] text-[11px] font-mono">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-gray-400">
          {labels.linesCount} <span className="text-gray-200 font-semibold">{totalLines.toLocaleString()}</span>
        </span>
        {filteredCount !== totalLines && (
          <>
            <span className="text-gray-600">|</span>
            <span className="text-blue-400">
              {labels.filtered} <span className="font-semibold">{filteredCount.toLocaleString()}</span>
            </span>
          </>
        )}
        {((stats.critical || 0) + (stats.error || 0)) > 0 && (
          <>
            <span className="text-gray-600">|</span>
            <span className="text-red-400">
              {labels.errorsCount} <span className="font-semibold">{((stats.critical || 0) + (stats.error || 0)).toLocaleString()}</span>
            </span>
          </>
        )}
        {(stats.warning || 0) > 0 && (
          <>
            <span className="text-gray-600">|</span>
            <span className="text-amber-400">
              {labels.warnCount} <span className="font-semibold">{(stats.warning || 0).toLocaleString()}</span>
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {paused && (
          <span className="text-amber-400 flex items-center gap-1 font-semibold">
            <Pause size={10} /> {labels.paused}
          </span>
        )}
        <span className="text-gray-500">
          {formatRelativeTime(connectedSeconds)}
        </span>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────

export function LogViewer({ instanceId, logUrl, active = true, extraToolbar, title }: LogViewerProps) {
  const t = useTranslations("logs");
  const tCommon = useTranslations("common");

  // --- Stream hook ---
  const stream = useLogStream({
    instanceId: instanceId || "",
    logUrl,
    enabled: active,
    initialLines: 200,
    pollInterval: 3000,
  });

  // --- Local UI state ---
  const [filters, setFilters] = useState<LogFilters>({ ...DEFAULT_FILTERS, levels: new Set(LOG_LEVELS) });
  const [fullscreen, setFullscreen] = useState(false);
  const [showTimestamp, setShowTimestamp] = useState(true);
  const [wordWrap, setWordWrap] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [bookmarks, setBookmarks] = useState<Set<number>>(new Set());
  const [collapsedTracebacks, setCollapsedTracebacks] = useState<Set<number>>(new Set());
  const [showFilters, setShowFilters] = useState(true);
  const [logLines, setLogLines] = useState(200);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevEntriesLen = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // --- Precompute labels for sub-components ---
  const connectionLabels = useMemo(() => ({
    statusLive: t("status.live"),
    statusLoading: t("status.loading"),
    statusPolling: t("status.polling"),
    statusDisconnected: t("status.disconnected"),
    statusError: t("status.error"),
    refreshNow: t("refreshNow"),
    retry: tCommon("retry"),
  }), [t, tCommon]);

  const logLineLabels = useMemo(() => ({
    removeBookmark: t("removeBookmark"),
    bookmarkLine: t("bookmarkLine"),
    expandTraceback: (count: number) => t("expandTraceback", { count }),
    collapseTraceback: t("collapseTraceback"),
    linesCollapsed: (count: number) => t("linesCollapsed", { count }),
  }), [t]);

  const statsLabels = useMemo(() => ({
    linesCount: t("linesCount"),
    filtered: t("filtered"),
    errorsCount: t("errorsCount"),
    warnCount: t("warnCount"),
    paused: t("paused"),
  }), [t]);

  // --- Filter entries ---
  const filteredEntries = useMemo(() => {
    return stream.entries.filter((e) => matchesFilter(e, filters));
  }, [stream.entries, filters]);

  // --- Handle traceback grouping ---
  const displayEntries = useMemo(() => {
    const result: Array<LogEntry & {
      _isTracebackHead: boolean;
      _tracebackCount: number;
      _hidden: boolean;
    }> = [];

    const tracebackGroups = new Map<number, LogEntry[]>();

    for (const entry of filteredEntries) {
      if (entry.is_traceback && entry.traceback_group_id !== null) {
        const group = tracebackGroups.get(entry.traceback_group_id) || [];
        group.push(entry);
        tracebackGroups.set(entry.traceback_group_id, group);
      }
    }

    for (const entry of filteredEntries) {
      if (entry.is_traceback && entry.traceback_group_id !== null) {
        const group = tracebackGroups.get(entry.traceback_group_id) || [];
        const isHead = group[0] === entry;
        const isCollapsed = collapsedTracebacks.has(entry.traceback_group_id);

        result.push({
          ...entry,
          _isTracebackHead: isHead,
          _tracebackCount: group.length,
          _hidden: isCollapsed && !isHead,
        });
      } else {
        result.push({
          ...entry,
          _isTracebackHead: false,
          _tracebackCount: 0,
          _hidden: false,
        });
      }
    }

    return result.filter((e) => !e._hidden);
  }, [filteredEntries, collapsedTracebacks]);

  // --- Unique loggers ---
  const loggers = useMemo(() => extractLoggers(stream.entries), [stream.entries]);

  // --- Auto-scroll ---
  useEffect(() => {
    if (autoScroll && displayEntries.length > prevEntriesLen.current) {
      const el = scrollRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
    prevEntriesLen.current = displayEntries.length;
  }, [displayEntries.length, autoScroll]);

  // --- Scroll detection ---
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  }, [autoScroll]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;

      if (e.key === " " && !e.ctrlKey) {
        e.preventDefault();
        stream.paused ? stream.resume() : stream.pause();
      }
      if (e.key === "g" && !e.ctrlKey && !e.shiftKey) {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        setAutoScroll(true);
      }
      if (e.key === "G" || (e.key === "g" && e.shiftKey)) {
        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
      if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        containerRef.current?.querySelector<HTMLInputElement>("[data-log-search]")?.focus();
      }
      if (e.key === "Escape") {
        if (filters.search) setFilters((f) => ({ ...f, search: "" }));
        else if (fullscreen) setFullscreen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stream, filters.search, fullscreen]);

  // --- Actions ---
  const toggleLevel = useCallback((level: LogLevel) => {
    setFilters((f) => {
      const next = new Set(f.levels);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return { ...f, levels: next };
    });
  }, []);

  const toggleBookmark = useCallback((lineNum: number) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(lineNum)) next.delete(lineNum);
      else next.add(lineNum);
      return next;
    });
  }, []);

  const toggleTraceback = useCallback((groupId: number) => {
    setCollapsedTracebacks((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    stream.clear();
  }, [stream]);

  const handleRefresh = useCallback(() => {
    stream.refresh();
  }, [stream]);

  const handleCopy = useCallback(async () => {
    const text = displayEntries.map((e) => e.raw).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  }, [displayEntries]);

  const handleDownload = useCallback(() => {
    const text = displayEntries.map((e) => e.raw).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${stream.instanceName || instanceId}-${new Date().toISOString().slice(0, 19)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [displayEntries, stream.instanceName, instanceId]);

  const handleLineChange = useCallback((lines: number) => {
    setLogLines(lines);
    stream.setLines(lines);
  }, [stream]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setAutoScroll(true);
  }, []);

  // --- Translated line count options ---
  const lineOptions = [50, 100, 200, 500, 1000];

  // --- Render ---
  const wrapperClass = fullscreen
    ? "fixed inset-0 z-50 flex flex-col bg-[#0d1117]"
    : "flex flex-col bg-[#0d1117] rounded-xl border border-[#30363d] overflow-hidden";

  return (
    <div ref={containerRef} className={wrapperClass}>
      {/* Top Toolbar */}
      <div className="flex flex-col border-b border-[#30363d] bg-[#161b22]">
        {/* Row 1: Main controls */}
        <div className="flex items-center justify-between px-3 py-2 gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <Terminal size={16} className="text-gray-400 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-200 truncate">
              {title || stream.instanceName || t("containerLogs")}
            </h3>
            {extraToolbar}
            <ConnectionStatus
              status={stream.status}
              onReconnect={stream.reconnect}
              onRefresh={handleRefresh}
              labels={connectionLabels}
            />
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Lines selector */}
            <select
              value={logLines}
              onChange={(e) => handleLineChange(parseInt(e.target.value))}
              className="text-xs bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1 text-gray-300 focus:border-blue-500 focus:outline-none"
            >
              {lineOptions.map((n) => (
                <option key={n} value={n}>{t("lines", { count: n })}</option>
              ))}
            </select>

            <div className="w-px h-5 bg-[#30363d] mx-1" />

            {/* Pause/Resume */}
            <button
              onClick={() => (stream.paused ? stream.resume() : stream.pause())}
              className={`p-1.5 rounded-md transition-colors ${
                stream.paused
                  ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
              title={stream.paused ? t("resumeRefresh") : t("pauseRefresh")}
            >
              {stream.paused ? <Play size={14} /> : <Pause size={14} />}
            </button>

            {/* Filter toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-1.5 rounded-md transition-colors ${
                showFilters
                  ? "bg-blue-500/20 text-blue-400"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
              title={t("toggleFilters")}
            >
              <Filter size={14} />
            </button>

            {/* Timestamp toggle */}
            <button
              onClick={() => setShowTimestamp(!showTimestamp)}
              className={`p-1.5 rounded-md text-[10px] font-mono font-bold transition-colors ${
                showTimestamp
                  ? "bg-purple-500/20 text-purple-400"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
              title={t("toggleTimestamps")}
            >
              T
            </button>

            {/* Word wrap */}
            <button
              onClick={() => setWordWrap(!wordWrap)}
              className={`p-1.5 rounded-md text-[10px] font-mono font-bold transition-colors ${
                wordWrap
                  ? "bg-cyan-500/20 text-cyan-400"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
              title={t("toggleWordWrap")}
            >
              W
            </button>

            <div className="w-px h-5 bg-[#30363d] mx-1" />

            {/* Copy */}
            <button
              onClick={handleCopy}
              className={`p-1.5 rounded-md transition-colors ${
                copyFeedback
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
              title={copyFeedback ? tCommon("copied") : t("copyLogs")}
            >
              <Copy size={14} />
            </button>

            {/* Download */}
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
              title={t("downloadLogs")}
            >
              <Download size={14} />
            </button>

            {/* Clear */}
            <button
              onClick={handleClear}
              className="p-1.5 rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title={t("clearDisplay")}
            >
              <Trash2 size={14} />
            </button>

            <div className="w-px h-5 bg-[#30363d] mx-1" />

            {/* Fullscreen */}
            <button
              onClick={() => setFullscreen(!fullscreen)}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors"
              title={fullscreen ? t("exitFullscreen") : t("fullscreen")}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>

        {/* Row 2: Filters */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-[#30363d]/50 bg-[#0d1117]/50">
            {/* Severity chips */}
            <SeverityChips
              activeLevels={filters.levels}
              stats={stream.stats}
              onToggle={toggleLevel}
            />

            <div className="w-px h-5 bg-[#30363d] mx-1" />

            {/* Search */}
            <div className="relative flex items-center">
              <Search size={13} className="absolute left-2.5 text-gray-500 pointer-events-none" />
              <input
                data-log-search
                type="text"
                value={filters.search}
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                placeholder={t("searchLogs")}
                className="pl-8 pr-8 py-1 w-[220px] text-xs bg-[#0d1117] border border-[#30363d] rounded-md text-gray-300 placeholder:text-gray-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              />
              {filters.search && (
                <button
                  onClick={() => setFilters((f) => ({ ...f, search: "" }))}
                  className="absolute right-2 text-gray-500 hover:text-gray-300"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Regex toggle */}
            <button
              onClick={() => setFilters((f) => ({ ...f, searchRegex: !f.searchRegex }))}
              className={`p-1.5 rounded-md transition-colors ${
                filters.searchRegex
                  ? "bg-green-500/20 text-green-400"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
              }`}
              title={t("toggleRegex")}
            >
              <Regex size={14} />
            </button>

            {/* Logger dropdown */}
            {loggers.length > 0 && (
              <>
                <div className="w-px h-5 bg-[#30363d] mx-1" />
                <select
                  value={filters.logger}
                  onChange={(e) => setFilters((f) => ({ ...f, logger: e.target.value }))}
                  className="text-xs bg-[#0d1117] border border-[#30363d] rounded-md px-2 py-1 text-gray-400 focus:border-blue-500 focus:outline-none max-w-[180px]"
                >
                  <option value="">{t("allLoggers")}</option>
                  {loggers.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </>
            )}

            {/* Quick filter buttons */}
            <div className="w-px h-5 bg-[#30363d] mx-1" />
            <button
              onClick={() => setFilters((f) => ({ ...f, levels: new Set<LogLevel>(["critical", "error"]) }))}
              className="px-2 py-1 text-[10px] font-medium rounded-md text-red-400/70 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all"
            >
              {t("errorsOnly")}
            </button>
            <button
              onClick={() => setFilters({ ...DEFAULT_FILTERS, levels: new Set(LOG_LEVELS) })}
              className="px-2 py-1 text-[10px] font-medium rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-all"
            >
              {tCommon("reset")}
            </button>
          </div>
        )}
      </div>

      {/* Log Content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-auto ${fullscreen ? "" : "max-h-[70vh]"} ${wordWrap ? "" : "whitespace-nowrap"}`}
        style={{ minHeight: fullscreen ? 0 : 300 }}
      >
        {displayEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-gray-600">
            {stream.status === "connecting" ? (
              <>
                <RefreshCw size={24} className="mb-2 animate-spin" />
                <span className="text-sm">{t("loadingLogs")}</span>
              </>
            ) : stream.status === "error" ? (
              <>
                <WifiOff size={24} className="mb-2 text-red-500" />
                <span className="text-sm text-red-400">{stream.error || t("connectionFailed")}</span>
                <button
                  onClick={stream.reconnect}
                  className="mt-2 px-3 py-1 text-xs bg-blue-500/20 text-blue-400 rounded-md hover:bg-blue-500/30"
                >
                  {tCommon("retry")}
                </button>
              </>
            ) : stream.entries.length > 0 ? (
              <>
                <Filter size={24} className="mb-2" />
                <span className="text-sm">{t("noLogsMatch")}</span>
                <button
                  onClick={() => setFilters({ ...DEFAULT_FILTERS, levels: new Set(LOG_LEVELS) })}
                  className="mt-2 px-3 py-1 text-xs bg-white/5 rounded-md hover:bg-white/10"
                >
                  {t("resetFilters")}
                </button>
              </>
            ) : (
              <>
                <ScrollText size={24} className="mb-2" />
                <span className="text-sm">{t("noLogsAvailable")}</span>
              </>
            )}
          </div>
        ) : (
          <div className="py-1">
            {displayEntries.map((entry) => (
              <LogLine
                key={`${entry.line_number}-${entry.raw.slice(0, 20)}`}
                entry={entry}
                searchTerm={filters.search}
                searchRegex={filters.searchRegex}
                isBookmarked={bookmarks.has(entry.line_number)}
                onBookmark={toggleBookmark}
                showTimestamp={showTimestamp}
                isTracebackCollapsed={
                  entry.traceback_group_id !== null && collapsedTracebacks.has(entry.traceback_group_id)
                }
                isTracebackHead={entry._isTracebackHead}
                tracebackCount={entry._tracebackCount}
                onToggleTraceback={toggleTraceback}
                labels={logLineLabels}
              />
            ))}
          </div>
        )}
      </div>

      {/* Scroll-to-bottom FAB */}
      {!autoScroll && displayEntries.length > 20 && (
        <div className="absolute bottom-12 right-6 z-10">
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs font-medium shadow-lg shadow-blue-500/20 hover:bg-blue-500 transition-colors"
          >
            <ArrowDown size={12} /> {t("scrollToBottom")}
          </button>
        </div>
      )}

      {/* Stats Footer */}
      <StatsFooter
        stats={stream.stats}
        totalLines={stream.entries.length}
        filteredCount={displayEntries.length}
        connectedSeconds={stream.connectedSeconds}
        paused={stream.paused}
        labels={statsLabels}
      />
    </div>
  );
}
