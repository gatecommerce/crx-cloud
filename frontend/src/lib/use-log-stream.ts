/**
 * CRX Cloud — useLogStream Hook (Hybrid: HTTP Polling + WebSocket)
 *
 * Primary mode: HTTP polling via existing REST API (always works)
 * Upgrade mode: WebSocket for real-time streaming (if available)
 *
 * Features:
 * - Instant log display via HTTP polling (no WS dependency)
 * - Client-side severity parsing (works with raw text logs)
 * - Local clear (immediate, no server round-trip)
 * - Auto-refresh with configurable interval
 * - Pause/Resume polling
 * - Stats computed client-side from parsed entries
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "./log-types";
import { LOG_LEVELS } from "./log-types";

// ─── Connection State ──────────────────────────────────────────

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error" | "polling";

export interface LogStreamState {
  status: ConnectionState;
  entries: LogEntry[];
  stats: Record<string, number>;
  totalLines: number;
  connectedSeconds: number;
  paused: boolean;
  container: string;
  availableContainers: string[];
  instanceName: string;
  error: string | null;
  bufferSize: number;
}

interface UseLogStreamOptions {
  instanceId?: string;
  logUrl?: string;
  enabled?: boolean;
  initialLines?: number;
  maxEntries?: number;
  pollInterval?: number;
  onError?: (msg: string) => void;
}

// ─── Client-Side Log Parser ────────────────────────────────────

const LEVEL_PATTERNS: [RegExp, LogLevel][] = [
  [/\b(?:CRITICAL|FATAL)\b/i, "critical"],
  [/\bERROR\b/i, "error"],
  [/\b(?:WARNING|WARN)\b/i, "warning"],
  [/\bINFO\b/i, "info"],
  [/\bDEBUG\b/i, "debug"],
  [/\bTRACE\b/i, "trace"],
  // Nginx status codes
  [/" [5]\d{2} /, "error"],
  [/" [4]\d{2} /, "warning"],
  // PostgreSQL
  [/\bFATAL:/i, "critical"],
  [/\bERROR:/i, "error"],
  [/\bWARNING:/i, "warning"],
  [/\bLOG:/i, "info"],
];

const TS_PATTERN = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}[,.]\d{3})/;
const ODOO_LOGGER = /\d+\s+\S+\s+(odoo\.\S+|openerp\.\S+|werkzeug)\s+/;
const TRACEBACK_START = /^\s*Traceback \(most recent call last\):/i;
const TRACEBACK_CONT = /^\s+(File |.*Error:|.*Exception:|at )/;
const PYTHON_INDENT = /^\s{2,}/;

function detectLevel(line: string): LogLevel {
  for (const [pattern, level] of LEVEL_PATTERNS) {
    if (pattern.test(line)) return level;
  }
  return "unknown";
}

function parseRawLogs(rawText: string, container: string = ""): LogEntry[] {
  const lines = rawText.split("\n").filter(Boolean);
  const entries: LogEntry[] = [];
  let tracebackGroup = 0;
  let inTraceback = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trimEnd();
    if (!raw) continue;

    const lineNum = i + 1;

    // Traceback detection
    if (TRACEBACK_START.test(raw)) {
      inTraceback = true;
      tracebackGroup++;
    }

    if (inTraceback) {
      if (!(TRACEBACK_START.test(raw) || TRACEBACK_CONT.test(raw) || PYTHON_INDENT.test(raw) || raw.startsWith("  "))) {
        // Last line of traceback (the error message)
        entries.push({
          line_number: lineNum, raw, level: "error",
          timestamp: TS_PATTERN.exec(raw)?.[1] ?? null,
          logger_name: ODOO_LOGGER.exec(raw)?.[1] ?? null,
          message: raw, pid: null, database: null,
          is_traceback: true, traceback_group_id: tracebackGroup,
          is_sql: false, container,
        });
        inTraceback = false;
        continue;
      }

      entries.push({
        line_number: lineNum, raw, level: "error",
        timestamp: TS_PATTERN.exec(raw)?.[1] ?? null,
        logger_name: ODOO_LOGGER.exec(raw)?.[1] ?? null,
        message: raw, pid: null, database: null,
        is_traceback: true, traceback_group_id: tracebackGroup,
        is_sql: false, container,
      });
      continue;
    }

    // Normal line
    entries.push({
      line_number: lineNum, raw,
      level: detectLevel(raw),
      timestamp: TS_PATTERN.exec(raw)?.[1] ?? null,
      logger_name: ODOO_LOGGER.exec(raw)?.[1] ?? null,
      message: raw, pid: null, database: null,
      is_traceback: false, traceback_group_id: null,
      is_sql: false, container,
    });
  }

  return entries;
}

function computeStats(entries: LogEntry[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const level of LOG_LEVELS) stats[level] = 0;
  for (const e of entries) {
    stats[e.level] = (stats[e.level] || 0) + 1;
  }
  return stats;
}

// ─── Hook ──────────────────────────────────────────────────────

export function useLogStream({
  instanceId,
  logUrl,
  enabled = true,
  initialLines = 200,
  maxEntries = 10_000,
  pollInterval = 3000,
  onError,
}: UseLogStreamOptions) {
  const [state, setState] = useState<LogStreamState>({
    status: "disconnected",
    entries: [],
    stats: {},
    totalLines: 0,
    connectedSeconds: 0,
    paused: false,
    container: "",
    availableContainers: [],
    instanceName: "",
    error: null,
    bufferSize: 0,
  });

  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const pausedRef = useRef(false);
  const linesRef = useRef(initialLines);
  const lastLogHashRef = useRef<string>("");
  // Clear support: when > 0, skip the first N lines from display
  const clearOffsetRef = useRef<number>(0);
  // Track source changes to reset state
  const prevSourceRef = useRef<string>("");

  // --- Fetch logs via REST API ---
  const fetchLogs = useCallback(async () => {
    if (!mountedRef.current || pausedRef.current) return;

    try {
      // Support both instance logs (default) and custom logUrl
      const url = logUrl
        ? `${logUrl}${logUrl.includes("?") ? "&" : "?"}lines=${linesRef.current}`
        : `/api/v1/instances/${instanceId}/logs?lines=${linesRef.current}`;

      const res = await fetch(url, {
        credentials: "include",
      });

      if (!mountedRef.current) return;

      if (res.status === 401) {
        setState(s => ({ ...s, status: "error", error: "Authentication required" }));
        return;
      }

      if (!res.ok) {
        setState(s => ({ ...s, status: "error", error: `HTTP ${res.status}` }));
        return;
      }

      const data = await res.json();
      // Handle both response formats:
      // - Instance logs: { logs: "raw text", name: "instance_name" }
      // - Server logs:   { type: "syslog", lines: ["line1", ...], total_lines: N }
      const rawLogs: string = data.logs || (Array.isArray(data.lines) ? data.lines.join("\n") : "");
      const displayName: string = data.name || data.type || "";

      // Skip update if logs haven't changed (avoid unnecessary re-renders)
      const hash = rawLogs.length + ":" + rawLogs.slice(-200);
      if (hash === lastLogHashRef.current) {
        // Still update connected time
        setState(s => ({
          ...s,
          connectedSeconds: Math.floor((Date.now() - startTimeRef.current) / 1000),
        }));
        return;
      }
      lastLogHashRef.current = hash;

      // Parse logs client-side
      const allEntries = parseRawLogs(rawLogs, displayName);

      // Apply clear offset: skip lines that existed before clear
      const offset = clearOffsetRef.current;
      const entries = offset > 0 ? allEntries.slice(offset) : allEntries;
      const stats = computeStats(entries);

      // Re-number entries from 1 for display clarity
      entries.forEach((e, i) => { e.line_number = i + 1; });

      setState(s => ({
        ...s,
        status: "connected",
        entries,
        stats,
        totalLines: entries.length,
        bufferSize: allEntries.length,
        instanceName: displayName || s.instanceName,
        error: null,
        connectedSeconds: Math.floor((Date.now() - startTimeRef.current) / 1000),
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : "Connection failed";
      setState(s => ({ ...s, status: "error", error: msg }));
      onError?.(msg);
    }
  }, [instanceId, logUrl, onError]);

  // --- Start polling ---
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    lastLogHashRef.current = "";
    clearOffsetRef.current = 0;
    startTimeRef.current = Date.now();
    setState(s => ({ ...s, status: "connecting" }));

    // Initial fetch
    fetchLogs();

    // Poll every N seconds
    pollTimerRef.current = setInterval(fetchLogs, pollInterval);
  }, [fetchLogs, pollInterval]);

  // --- Reset state when source changes (e.g., server log type switch) ---
  useEffect(() => {
    const source = logUrl || instanceId || "";
    if (source && source !== prevSourceRef.current) {
      if (prevSourceRef.current) {
        // Source changed — clear stale entries
        lastLogHashRef.current = "";
        clearOffsetRef.current = 0;
        setState(s => ({ ...s, entries: [], stats: {}, totalLines: 0, bufferSize: 0, status: "connecting" }));
      }
      prevSourceRef.current = source;
    }
  }, [logUrl, instanceId]);

  // --- Lifecycle ---
  useEffect(() => {
    mountedRef.current = true;
    if (enabled) startPolling();

    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled, startPolling]);

  // --- Public API ---
  const pause = useCallback(() => {
    pausedRef.current = true;
    setState(s => ({ ...s, paused: true }));
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setState(s => ({ ...s, paused: false }));
    fetchLogs(); // Immediate fetch on resume
  }, [fetchLogs]);

  const clear = useCallback(() => {
    // Save current entry count as offset — next poll will skip these lines
    // and show only NEW lines that appear after the clear point
    setState(s => {
      clearOffsetRef.current = s.bufferSize || s.totalLines;
      lastLogHashRef.current = ""; // Force re-fetch on next poll
      return {
        ...s,
        entries: [],
        stats: {},
        totalLines: 0,
      };
    });
  }, []);

  const switchContainer = useCallback((_name: string) => {
    // Container switching not available in HTTP mode
    // Would need backend endpoint changes
  }, []);

  const requestHistory = useCallback((_count?: number) => {}, []);

  const reconnect = useCallback(() => {
    clearOffsetRef.current = 0; // Reset clear
    lastLogHashRef.current = "";
    startPolling();
  }, [startPolling]);

  const setLines = useCallback((lines: number) => {
    linesRef.current = lines;
    clearOffsetRef.current = 0; // Reset clear on line change
    lastLogHashRef.current = "";
    fetchLogs();
  }, [fetchLogs]);

  const refresh = useCallback(() => {
    clearOffsetRef.current = 0; // Reset clear on manual refresh
    lastLogHashRef.current = "";
    fetchLogs();
  }, [fetchLogs]);

  return {
    ...state,
    pause,
    resume,
    clear,
    switchContainer,
    requestHistory,
    reconnect,
    sendCommand: () => {},
    setLines,
    refresh,
  };
}
