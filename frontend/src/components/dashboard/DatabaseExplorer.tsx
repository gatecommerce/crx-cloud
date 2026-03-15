"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import { databaseApi } from "@/lib/api";
import {
  Database, Table2, Search, ChevronRight, ChevronDown, ChevronLeft,
  Loader2, RefreshCw, Download, Plus, Trash2, Save, X, Eye,
  ArrowUp, ArrowDown, Filter, Terminal, Zap, AlertTriangle,
  Copy, Check, Key, Link2, Hash, Type, Calendar, ToggleLeft,
  BarChart3, HardDrive, Users, Package, Shield, Eraser,
  Play, Clock, FileText, Edit3, ChevronUp, Info, ExternalLink,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────

interface TableInfo {
  name: string;
  label: string;
  row_count: number;
  size_bytes: number;
  size_pretty: string;
  category: string;
  is_system: boolean;
  has_primary_key: boolean;
}

interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value: string | null;
  max_length: number | null;
  foreign_key: { table: string; column: string } | null;
  odoo_field_type: string | null;
  odoo_label: string | null;
}

interface QueryResult {
  columns: string[];
  rows: any[][];
  row_count: number;
  total_count: number;
  execution_time_ms: number;
  query: string;
  mode: string;
  affected_rows: number;
  error: string | null;
  warnings: string[];
}

interface DbStats {
  db_name: string;
  db_size: string;
  total_tables: number;
  total_rows: number;
  largest_tables: { name: string; rows: number; size: string }[];
  active_connections: number;
  pg_version: string;
  cache_hit_ratio: number;
}

interface IndexInfo {
  name: string;
  table: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  size_pretty: string;
  index_scans: number;
  suggestion: string | null;
}

type SubTab = "browser" | "sql" | "actions" | "stats";

// ── Category Colors ─────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  Sales: "text-blue-400",
  Purchase: "text-orange-400",
  Inventory: "text-amber-400",
  Accounting: "text-emerald-400",
  Products: "text-purple-400",
  Contacts: "text-cyan-400",
  HR: "text-pink-400",
  Projects: "text-indigo-400",
  POS: "text-rose-400",
  System: "text-gray-500",
  Other: "text-gray-400",
};

// ── Data Type Icons ─────────────────────────────────────────────

function DataTypeIcon({ type, isPk, isFk }: { type: string; isPk: boolean; isFk: boolean }) {
  if (isPk) return <Key className="w-3.5 h-3.5 text-amber-400" />;
  if (isFk) return <Link2 className="w-3.5 h-3.5 text-blue-400" />;
  if (type.includes("int") || type === "numeric" || type === "double precision") return <Hash className="w-3.5 h-3.5 text-emerald-400" />;
  if (type.includes("char") || type === "text") return <Type className="w-3.5 h-3.5 text-purple-400" />;
  if (type.includes("timestamp") || type === "date") return <Calendar className="w-3.5 h-3.5 text-orange-400" />;
  if (type === "boolean") return <ToggleLeft className="w-3.5 h-3.5 text-cyan-400" />;
  if (type === "jsonb" || type === "json") return <FileText className="w-3.5 h-3.5 text-yellow-400" />;
  return <Database className="w-3.5 h-3.5 text-gray-500" />;
}

// ── Main Component ──────────────────────────────────────────────

export default function DatabaseExplorer({ instanceId }: { instanceId: string }) {
  // Sub-tab navigation
  const [subTab, setSubTab] = useState<SubTab>("browser");

  // Table browser state
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(["Contacts", "Sales", "Products"]));

  // Column state
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);

  // Records state
  const [records, setRecords] = useState<QueryResult | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [orderBy, setOrderBy] = useState("id");
  const [orderDir, setOrderDir] = useState<"ASC" | "DESC">("DESC");
  const [recordSearch, setRecordSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);

  // Inline edit state
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Insert modal state
  const [showInsertModal, setShowInsertModal] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, string>>({});
  const [insertSaving, setInsertSaving] = useState(false);

  // Delete confirm state
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // SQL Console state
  const [sqlQuery, setSqlQuery] = useState("");
  const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlHistory, setSqlHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const sqlInputRef = useRef<HTMLTextAreaElement>(null);

  // Stats state
  const [stats, setStats] = useState<DbStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Index state
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [indexesLoading, setIndexesLoading] = useState(false);

  // Quick actions state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<QueryResult | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState("");
  const [activeUsers, setActiveUsers] = useState<QueryResult | null>(null);
  const [installedModules, setInstalledModules] = useState<QueryResult | null>(null);

  // Copy feedback
  const [copiedCell, setCopiedCell] = useState<string | null>(null);

  // Error state
  const [tablesError, setTablesError] = useState<string | null>(null);

  // ── Load Tables ─────────────────────────────────────────────────

  const loadTables = useCallback(async () => {
    setTablesLoading(true);
    setTablesError(null);
    try {
      const data = await databaseApi.listTables(instanceId);
      setTables(data);
    } catch (err) {
      setTables([]);
      setTablesError(err instanceof Error ? err.message : "Failed to load tables");
    }
    finally { setTablesLoading(false); }
  }, [instanceId]);

  useEffect(() => { loadTables(); }, [loadTables]);

  // ── Load Columns ────────────────────────────────────────────────

  const loadColumns = useCallback(async (table: string) => {
    setColumnsLoading(true);
    try {
      const data = await databaseApi.getColumns(instanceId, table);
      setColumns(data);
    } catch { setColumns([]); }
    finally { setColumnsLoading(false); }
  }, [instanceId]);

  // ── Load Records ────────────────────────────────────────────────

  const loadRecords = useCallback(async (table: string, p?: number) => {
    setRecordsLoading(true);
    try {
      const data = await databaseApi.getRecords(instanceId, table, {
        page: p ?? page,
        page_size: pageSize,
        order_by: orderBy,
        order_dir: orderDir,
        search: recordSearch,
        filters: Object.keys(columnFilters).length > 0 ? columnFilters : undefined,
      });
      setRecords(data);
    } catch { setRecords(null); }
    finally { setRecordsLoading(false); }
  }, [instanceId, page, pageSize, orderBy, orderDir, recordSearch, columnFilters]);

  // ── Select Table ────────────────────────────────────────────────

  const selectTable = useCallback((table: string) => {
    setSelectedTable(table);
    setPage(1);
    setOrderBy("id");
    setOrderDir("DESC");
    setRecordSearch("");
    setColumnFilters({});
    setEditingCell(null);
    loadColumns(table);
    loadRecords(table, 1);
  }, [loadColumns, loadRecords]);

  // Reload records when params change
  useEffect(() => {
    if (selectedTable) loadRecords(selectedTable);
  }, [page, orderBy, orderDir]);

  // ── Stats ───────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await databaseApi.getStats(instanceId);
      setStats(data);
    } catch { setStats(null); }
    finally { setStatsLoading(false); }
  }, [instanceId]);

  useEffect(() => {
    if (subTab === "stats") loadStats();
  }, [subTab, loadStats]);

  // ── Indexes ─────────────────────────────────────────────────────

  const loadIndexes = useCallback(async (table: string) => {
    setIndexesLoading(true);
    try {
      const data = await databaseApi.getIndexes(instanceId, table);
      setIndexes(data);
    } catch { setIndexes([]); }
    finally { setIndexesLoading(false); }
  }, [instanceId]);

  // ── Inline Edit ─────────────────────────────────────────────────

  const startEdit = (rowIdx: number, colName: string, currentValue: any) => {
    setEditingCell({ row: rowIdx, col: colName });
    setEditValue(currentValue?.toString() ?? "");
  };

  const saveEdit = async () => {
    if (!editingCell || !selectedTable || !records) return;
    const idColIdx = records.columns.indexOf("id");
    if (idColIdx === -1) return;
    const recordId = parseInt(records.rows[editingCell.row][idColIdx]);
    if (isNaN(recordId)) return;

    setEditSaving(true);
    try {
      await databaseApi.updateRecord(instanceId, selectedTable, recordId, {
        [editingCell.col]: editValue === "" ? null : editValue,
      });
      setEditingCell(null);
      loadRecords(selectedTable);
    } catch (err: any) {
      alert(err.message || "Update failed");
    } finally {
      setEditSaving(false);
    }
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  // ── Insert Record ───────────────────────────────────────────────

  const openInsertModal = () => {
    const vals: Record<string, string> = {};
    columns.forEach(c => {
      if (!c.is_primary_key && c.name !== "create_date" && c.name !== "write_date") {
        vals[c.name] = c.default_value || "";
      }
    });
    setInsertValues(vals);
    setShowInsertModal(true);
  };

  const doInsert = async () => {
    if (!selectedTable) return;
    setInsertSaving(true);
    try {
      const cleanVals: Record<string, any> = {};
      for (const [k, v] of Object.entries(insertValues)) {
        if (v !== "") cleanVals[k] = v;
      }
      await databaseApi.insertRecord(instanceId, selectedTable, cleanVals);
      setShowInsertModal(false);
      loadRecords(selectedTable);
    } catch (err: any) {
      alert(err.message || "Insert failed");
    } finally {
      setInsertSaving(false);
    }
  };

  // ── Delete Record ───────────────────────────────────────────────

  const doDelete = async (recordId: number) => {
    if (!selectedTable) return;
    setDeleteLoading(true);
    try {
      await databaseApi.deleteRecord(instanceId, selectedTable, recordId);
      setDeleteConfirm(null);
      loadRecords(selectedTable);
    } catch (err: any) {
      alert(err.message || "Delete failed");
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── SQL Console ─────────────────────────────────────────────────

  const executeSQL = async () => {
    if (!sqlQuery.trim()) return;
    setSqlLoading(true);
    setSqlResult(null);
    try {
      const data = await databaseApi.executeQuery(instanceId, sqlQuery);
      setSqlResult(data);
      // Add to history
      setSqlHistory(prev => {
        const next = [sqlQuery, ...prev.filter(q => q !== sqlQuery)].slice(0, 50);
        return next;
      });
    } catch (err: any) {
      setSqlResult({
        columns: [], rows: [], row_count: 0, total_count: 0,
        execution_time_ms: 0, query: sqlQuery, mode: "read",
        affected_rows: 0, error: err.message, warnings: [],
      });
    } finally {
      setSqlLoading(false);
    }
  };

  const handleSqlKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeSQL();
    }
  };

  // ── Copy Cell ───────────────────────────────────────────────────

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCell(key);
    setTimeout(() => setCopiedCell(null), 1500);
  };

  // ── Sort Handler ────────────────────────────────────────────────

  const toggleSort = (col: string) => {
    if (orderBy === col) {
      setOrderDir(prev => prev === "ASC" ? "DESC" : "ASC");
    } else {
      setOrderBy(col);
      setOrderDir("ASC");
    }
    setPage(1);
  };

  // ── Table Search Filter ─────────────────────────────────────────

  const filteredTables = tables.filter(t =>
    t.name.toLowerCase().includes(tableSearch.toLowerCase()) ||
    t.label.toLowerCase().includes(tableSearch.toLowerCase())
  );

  const groupedTables: Record<string, TableInfo[]> = {};
  filteredTables.forEach(t => {
    if (!groupedTables[t.category]) groupedTables[t.category] = [];
    groupedTables[t.category].push(t);
  });

  const totalPages = records ? Math.ceil(records.total_count / pageSize) : 0;
  const selectedTableInfo = tables.find(t => t.name === selectedTable);

  // ── Quick Actions ───────────────────────────────────────────────

  const runAction = async (action: string, payload?: any) => {
    setActionLoading(action);
    setActionResult(null);
    try {
      let result;
      switch (action) {
        case "cleanup-sessions":
          result = await databaseApi.cleanupSessions(instanceId);
          break;
        case "cleanup-attachments":
          result = await databaseApi.cleanupAttachments(instanceId);
          break;
        case "reset-password":
          if (!resetPwdValue || resetPwdValue.length < 8) {
            alert("Password must be at least 8 characters");
            return;
          }
          result = await databaseApi.resetPassword(instanceId, resetPwdValue);
          setResetPwdValue("");
          break;
        case "active-users":
          result = await databaseApi.getActiveUsers(instanceId);
          setActiveUsers(result);
          break;
        case "installed-modules":
          result = await databaseApi.getInstalledModules(instanceId);
          setInstalledModules(result);
          break;
        case "toggle-user":
          result = await databaseApi.toggleUser(instanceId, payload.userId, payload.active);
          // Reload users
          const updated = await databaseApi.getActiveUsers(instanceId);
          setActiveUsers(updated);
          break;
      }
      if (result && action !== "active-users" && action !== "installed-modules") {
        setActionResult(result);
      }
    } catch (err: any) {
      setActionResult({
        columns: [], rows: [], row_count: 0, total_count: 0,
        execution_time_ms: 0, query: "", mode: "write",
        affected_rows: 0, error: err.message, warnings: [],
      });
    } finally {
      setActionLoading(null);
    }
  };

  // ── Sub-Tab Navigation ──────────────────────────────────────────

  const subTabs: { id: SubTab; label: string; icon: typeof Database }[] = [
    { id: "browser", label: "Table Browser", icon: Table2 },
    { id: "sql", label: "SQL Console", icon: Terminal },
    { id: "actions", label: "Quick Actions", icon: Zap },
    { id: "stats", label: "Statistics", icon: BarChart3 },
  ];

  return (
    <div className="space-y-4">
      {/* Sub-tab navigation */}
      <div className="flex gap-1 bg-[var(--card)] rounded-lg p-1">
        {subTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              subTab === tab.id
                ? "bg-[var(--accent)] text-white"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ═══ TABLE BROWSER ═══ */}
      {subTab === "browser" && (
        <div className="flex gap-4" style={{ minHeight: "600px" }}>
          {/* Left sidebar — Table list */}
          <div className="w-72 shrink-0 bg-[var(--card)] rounded-xl border border-white/5 flex flex-col">
            {/* Search */}
            <div className="p-3 border-b border-white/5">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  value={tableSearch}
                  onChange={e => setTableSearch(e.target.value)}
                  placeholder="Search tables..."
                  className="w-full pl-9 pr-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-gray-500">{tables.length} tables</span>
                <button onClick={loadTables} className="text-gray-500 hover:text-white transition-colors">
                  <RefreshCw className={`w-3.5 h-3.5 ${tablesLoading ? "animate-spin" : ""}`} />
                </button>
              </div>
            </div>

            {/* Table tree */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {tablesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
                </div>
              ) : tablesError ? (
                <div className="flex flex-col items-center gap-2 py-8 px-3 text-center">
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                  <p className="text-xs text-red-400">{tablesError}</p>
                  <button onClick={loadTables} className="text-xs text-[var(--accent)] hover:underline">Retry</button>
                </div>
              ) : tables.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 px-3 text-center">
                  <Table2 className="w-5 h-5 text-gray-600" />
                  <p className="text-xs text-gray-500">No tables found</p>
                </div>
              ) : (
                Object.entries(groupedTables)
                  .sort(([a], [b]) => a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b))
                  .map(([category, catTables]) => (
                    <div key={category}>
                      <button
                        onClick={() => setExpandedCategories(prev => {
                          const next = new Set(prev);
                          next.has(category) ? next.delete(category) : next.add(category);
                          return next;
                        })}
                        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300"
                      >
                        {expandedCategories.has(category) ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        <span className={CATEGORY_COLORS[category] || "text-gray-500"}>{category}</span>
                        <span className="ml-auto text-gray-600">{catTables.length}</span>
                      </button>
                      {expandedCategories.has(category) && (
                        <div className="ml-2 space-y-0.5">
                          {catTables.map(t => (
                            <button
                              key={t.name}
                              onClick={() => selectTable(t.name)}
                              className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm transition-colors ${
                                selectedTable === t.name
                                  ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                                  : "text-gray-300 hover:bg-white/5 hover:text-white"
                              }`}
                            >
                              <Table2 className={`w-3.5 h-3.5 shrink-0 ${t.is_system ? "text-gray-600" : "text-gray-400"}`} />
                              <span className="truncate text-left flex-1">{t.label}</span>
                              <span className="text-xs text-gray-600 tabular-nums">{t.row_count.toLocaleString()}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
              )}
            </div>
          </div>

          {/* Right panel — Records grid */}
          <div className="flex-1 bg-[var(--card)] rounded-xl border border-white/5 flex flex-col min-w-0">
            {!selectedTable ? (
              <div className="flex-1 flex items-center justify-center text-gray-500">
                <div className="text-center">
                  <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="text-lg font-medium">Select a table</p>
                  <p className="text-sm mt-1">Choose a table from the sidebar to browse its data</p>
                </div>
              </div>
            ) : (
              <>
                {/* Table header bar */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-white font-semibold truncate">
                        {selectedTableInfo?.label || selectedTable}
                      </h3>
                      <code className="text-xs text-gray-500 bg-white/5 px-1.5 py-0.5 rounded">{selectedTable}</code>
                      {selectedTableInfo?.is_system && (
                        <span className="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <Shield className="w-3 h-3" /> System
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      <span>{records?.total_count?.toLocaleString() || 0} rows</span>
                      <span>{selectedTableInfo?.size_pretty}</span>
                      <span>{columns.length} columns</span>
                    </div>
                  </div>

                  {/* Search */}
                  <div className="relative w-56">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                    <input
                      type="text"
                      value={recordSearch}
                      onChange={e => { setRecordSearch(e.target.value); setPage(1); }}
                      onKeyDown={e => { if (e.key === "Enter" && selectedTable) loadRecords(selectedTable, 1); }}
                      placeholder="Search records..."
                      className="w-full pl-8 pr-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={`p-1.5 rounded-md transition-colors ${showFilters ? "bg-[var(--accent)]/20 text-[var(--accent)]" : "text-gray-500 hover:text-white"}`}
                  >
                    <Filter className="w-4 h-4" />
                  </button>

                  <button
                    onClick={() => selectedTable && loadRecords(selectedTable)}
                    className="p-1.5 text-gray-500 hover:text-white rounded-md transition-colors"
                  >
                    <RefreshCw className={`w-4 h-4 ${recordsLoading ? "animate-spin" : ""}`} />
                  </button>

                  {!selectedTableInfo?.is_system && (
                    <button
                      onClick={openInsertModal}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent)]/80 text-white text-sm rounded-lg transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Insert
                    </button>
                  )}

                  <a
                    href={databaseApi.exportTable(instanceId, selectedTable)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-gray-300 text-sm rounded-lg transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> CSV
                  </a>
                </div>

                {/* Column filters row */}
                {showFilters && (
                  <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-white/[0.02] overflow-x-auto">
                    <Filter className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    {columns.slice(0, 8).map(col => (
                      <div key={col.name} className="relative shrink-0">
                        <input
                          type="text"
                          placeholder={col.odoo_label || col.name}
                          value={columnFilters[col.name] || ""}
                          onChange={e => {
                            const next = { ...columnFilters };
                            if (e.target.value) next[col.name] = e.target.value;
                            else delete next[col.name];
                            setColumnFilters(next);
                          }}
                          onKeyDown={e => { if (e.key === "Enter" && selectedTable) { setPage(1); loadRecords(selectedTable, 1); } }}
                          className="w-28 px-2 py-1 bg-white/5 border border-white/10 rounded text-xs text-white placeholder-gray-600 focus:outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                    ))}
                    {Object.keys(columnFilters).length > 0 && (
                      <button
                        onClick={() => { setColumnFilters({}); setPage(1); if (selectedTable) loadRecords(selectedTable, 1); }}
                        className="text-xs text-gray-500 hover:text-white shrink-0"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}

                {/* Data grid */}
                <div className="flex-1 overflow-auto">
                  {recordsLoading && !records ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
                    </div>
                  ) : records && records.columns.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-[var(--card)] border-b border-white/10">
                          {records.columns.map((col) => {
                            const colInfo = columns.find(c => c.name === col);
                            return (
                              <th
                                key={col}
                                onClick={() => toggleSort(col)}
                                className="px-3 py-2 text-left text-xs font-medium text-gray-400 cursor-pointer hover:text-white select-none whitespace-nowrap"
                              >
                                <div className="flex items-center gap-1.5">
                                  <DataTypeIcon
                                    type={colInfo?.data_type || ""}
                                    isPk={colInfo?.is_primary_key || false}
                                    isFk={!!colInfo?.foreign_key}
                                  />
                                  <span>{colInfo?.odoo_label || col}</span>
                                  {orderBy === col && (
                                    orderDir === "ASC" ? <ArrowUp className="w-3 h-3 text-[var(--accent)]" /> : <ArrowDown className="w-3 h-3 text-[var(--accent)]" />
                                  )}
                                </div>
                                {colInfo?.odoo_label && colInfo.odoo_label !== col && (
                                  <div className="text-[10px] text-gray-600 font-normal">{col}</div>
                                )}
                              </th>
                            );
                          })}
                          {!selectedTableInfo?.is_system && (
                            <th className="px-3 py-2 text-right text-xs font-medium text-gray-400 w-20">Actions</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {records.rows.map((row, rowIdx) => (
                          <tr key={rowIdx} className="border-b border-white/5 hover:bg-white/[0.02] group">
                            {row.map((cell, colIdx) => {
                              const colName = records.columns[colIdx];
                              const colInfo = columns.find(c => c.name === colName);
                              const isEditing = editingCell?.row === rowIdx && editingCell?.col === colName;
                              const isPk = colInfo?.is_primary_key;
                              const isFk = !!colInfo?.foreign_key;
                              const cellKey = `${rowIdx}-${colIdx}`;

                              return (
                                <td key={colIdx} className="px-3 py-1.5 text-gray-300 max-w-[300px]">
                                  {isEditing ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="text"
                                        value={editValue}
                                        onChange={e => setEditValue(e.target.value)}
                                        onKeyDown={e => {
                                          if (e.key === "Enter") saveEdit();
                                          if (e.key === "Escape") cancelEdit();
                                        }}
                                        autoFocus
                                        className="w-full px-1.5 py-0.5 bg-white/10 border border-[var(--accent)] rounded text-sm text-white focus:outline-none"
                                      />
                                      <button onClick={saveEdit} disabled={editSaving} className="text-emerald-400 hover:text-emerald-300">
                                        {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                      </button>
                                      <button onClick={cancelEdit} className="text-gray-500 hover:text-white">
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1 group/cell">
                                      <span
                                        className={`truncate ${isPk ? "text-amber-400 font-mono text-xs" : ""} ${isFk ? "text-blue-400 cursor-pointer hover:underline" : ""} ${cell === "" || cell === null ? "text-gray-600 italic" : ""}`}
                                        onClick={() => {
                                          if (isFk && colInfo?.foreign_key && cell) {
                                            selectTable(colInfo.foreign_key.table);
                                          }
                                        }}
                                        onDoubleClick={() => {
                                          if (!isPk && !selectedTableInfo?.is_system) {
                                            startEdit(rowIdx, colName, cell);
                                          }
                                        }}
                                        title={cell?.toString() || "NULL"}
                                      >
                                        {cell === "" || cell === null ? "NULL" : cell.toString().substring(0, 200)}
                                      </span>
                                      <button
                                        onClick={() => copyToClipboard(cell?.toString() || "", cellKey)}
                                        className="opacity-0 group-hover/cell:opacity-100 transition-opacity text-gray-600 hover:text-gray-400"
                                      >
                                        {copiedCell === cellKey ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                      </button>
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                            {!selectedTableInfo?.is_system && (
                              <td className="px-3 py-1.5 text-right">
                                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {(() => {
                                    const idColIdx = records.columns.indexOf("id");
                                    const recordId = idColIdx >= 0 ? parseInt(row[idColIdx]) : null;
                                    if (!recordId) return null;
                                    return (
                                      <>
                                        <button
                                          onClick={() => {
                                            const pkCol = columns.find(c => c.is_primary_key);
                                            if (pkCol) startEdit(rowIdx, records.columns[1] || records.columns[0], row[1] || row[0]);
                                          }}
                                          className="p-1 text-gray-500 hover:text-blue-400 rounded"
                                          title="Edit"
                                        >
                                          <Edit3 className="w-3.5 h-3.5" />
                                        </button>
                                        {deleteConfirm === recordId ? (
                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={() => doDelete(recordId)}
                                              disabled={deleteLoading}
                                              className="px-1.5 py-0.5 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
                                            >
                                              {deleteLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                                            </button>
                                            <button
                                              onClick={() => setDeleteConfirm(null)}
                                              className="text-gray-500 hover:text-white"
                                            >
                                              <X className="w-3 h-3" />
                                            </button>
                                          </div>
                                        ) : (
                                          <button
                                            onClick={() => setDeleteConfirm(recordId)}
                                            className="p-1 text-gray-500 hover:text-red-400 rounded"
                                            title="Delete"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        )}
                                      </>
                                    );
                                  })()}
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500">
                      No records found
                    </div>
                  )}
                </div>

                {/* Pagination */}
                {records && records.total_count > 0 && (
                  <div className="flex items-center justify-between px-4 py-2 border-t border-white/5 text-sm">
                    <span className="text-gray-500">
                      {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, records.total_count).toLocaleString()} of {records.total_count.toLocaleString()}
                      <span className="ml-2 text-gray-600">({records.execution_time_ms}ms)</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage(Math.max(1, page - 1))}
                        disabled={page <= 1}
                        className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-gray-400 tabular-nums">
                        {page} / {totalPages}
                      </span>
                      <button
                        onClick={() => setPage(Math.min(totalPages, page + 1))}
                        disabled={page >= totalPages}
                        className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ SQL CONSOLE ═══ */}
      {subTab === "sql" && (
        <div className="space-y-4">
          <div className="bg-[var(--card)] rounded-xl border border-white/5 overflow-hidden">
            {/* SQL Editor */}
            <div className="relative">
              <textarea
                ref={sqlInputRef}
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                onKeyDown={handleSqlKeyDown}
                placeholder="SELECT * FROM res_partner WHERE active = true LIMIT 10;"
                rows={6}
                spellCheck={false}
                className="w-full p-4 bg-transparent text-sm text-white font-mono placeholder-gray-600 focus:outline-none resize-y"
                style={{ minHeight: "120px" }}
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-2">
                <span className="text-[10px] text-gray-600">Ctrl+Enter to run</span>
                <button
                  onClick={() => setSqlQuery("")}
                  className="text-gray-600 hover:text-gray-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-t border-white/5 bg-white/[0.02]">
              <button
                onClick={executeSQL}
                disabled={sqlLoading || !sqlQuery.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {sqlLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Execute
              </button>

              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                  showHistory ? "bg-[var(--accent)]/20 text-[var(--accent)]" : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                <Clock className="w-4 h-4" /> History ({sqlHistory.length})
              </button>

              {sqlResult && (
                <span className="ml-auto text-xs text-gray-500">
                  {sqlResult.row_count} rows in {sqlResult.execution_time_ms}ms
                  {sqlResult.mode === "write" && ` | ${sqlResult.affected_rows} affected`}
                </span>
              )}
            </div>

            {/* History dropdown */}
            {showHistory && sqlHistory.length > 0 && (
              <div className="border-t border-white/5 max-h-48 overflow-y-auto">
                {sqlHistory.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => { setSqlQuery(q); setShowHistory(false); }}
                    className="w-full px-4 py-2 text-left text-sm text-gray-400 hover:bg-white/5 hover:text-white font-mono truncate border-b border-white/5 last:border-0"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* SQL Result */}
          {sqlResult && (
            <div className="bg-[var(--card)] rounded-xl border border-white/5 overflow-hidden">
              {sqlResult.error ? (
                <div className="p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-red-400 font-medium">Query Error</p>
                    <pre className="mt-1 text-sm text-gray-400 whitespace-pre-wrap font-mono">{sqlResult.error}</pre>
                  </div>
                </div>
              ) : sqlResult.warnings.length > 0 ? (
                <div className="px-4 py-2 bg-amber-400/10 border-b border-amber-400/20">
                  {sqlResult.warnings.map((w, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-amber-400">
                      <AlertTriangle className="w-4 h-4" /> {w}
                    </div>
                  ))}
                </div>
              ) : null}

              {sqlResult.columns.length > 0 && (
                <div className="overflow-auto max-h-[500px]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-[var(--card)] border-b border-white/10">
                        {sqlResult.columns.map(col => (
                          <th key={col} className="px-3 py-2 text-left text-xs font-medium text-gray-400 whitespace-nowrap">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sqlResult.rows.map((row, i) => (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                          {row.map((cell, j) => (
                            <td key={j} className="px-3 py-1.5 text-gray-300 max-w-[300px] truncate font-mono text-xs">
                              {cell === null || cell === "" ? <span className="text-gray-600 italic">NULL</span> : cell.toString().substring(0, 200)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {sqlResult.mode === "write" && !sqlResult.error && (
                <div className="px-4 py-3 text-sm text-emerald-400 flex items-center gap-2">
                  <Check className="w-4 h-4" />
                  {sqlResult.affected_rows} row(s) affected in {sqlResult.execution_time_ms}ms
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ QUICK ACTIONS ═══ */}
      {subTab === "actions" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Reset Admin Password */}
          <div className="bg-[var(--card)] rounded-xl border border-white/5 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-400/10 rounded-lg"><Key className="w-5 h-5 text-amber-400" /></div>
              <div>
                <h3 className="text-white font-semibold">Reset Admin Password</h3>
                <p className="text-xs text-gray-500">Reset the Odoo admin (uid=2) password</p>
              </div>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={resetPwdValue}
                onChange={e => setResetPwdValue(e.target.value)}
                placeholder="New password (min 8 chars)"
                className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => runAction("reset-password")}
                disabled={actionLoading === "reset-password" || resetPwdValue.length < 8}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {actionLoading === "reset-password" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Reset"}
              </button>
            </div>
          </div>

          {/* Cleanup Sessions */}
          <div className="bg-[var(--card)] rounded-xl border border-white/5 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-400/10 rounded-lg"><Eraser className="w-5 h-5 text-blue-400" /></div>
              <div>
                <h3 className="text-white font-semibold">Cleanup Sessions</h3>
                <p className="text-xs text-gray-500">Remove expired HTTP sessions from database</p>
              </div>
            </div>
            <button
              onClick={() => runAction("cleanup-sessions")}
              disabled={actionLoading === "cleanup-sessions"}
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {actionLoading === "cleanup-sessions" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Clean Sessions"}
            </button>
          </div>

          {/* Orphan Attachments */}
          <div className="bg-[var(--card)] rounded-xl border border-white/5 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-purple-400/10 rounded-lg"><HardDrive className="w-5 h-5 text-purple-400" /></div>
              <div>
                <h3 className="text-white font-semibold">Orphan Attachments</h3>
                <p className="text-xs text-gray-500">Detect attachments with no linked record</p>
              </div>
            </div>
            <button
              onClick={() => runAction("cleanup-attachments")}
              disabled={actionLoading === "cleanup-attachments"}
              className="px-4 py-2 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {actionLoading === "cleanup-attachments" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Scan Attachments"}
            </button>
          </div>

          {/* Active Users */}
          <div className="bg-[var(--card)] rounded-xl border border-white/5 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-emerald-400/10 rounded-lg"><Users className="w-5 h-5 text-emerald-400" /></div>
              <div>
                <h3 className="text-white font-semibold">User Management</h3>
                <p className="text-xs text-gray-500">View and toggle active Odoo users</p>
              </div>
            </div>
            <button
              onClick={() => runAction("active-users")}
              disabled={actionLoading === "active-users"}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {actionLoading === "active-users" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Load Users"}
            </button>
          </div>

          {/* Installed Modules */}
          <div className="bg-[var(--card)] rounded-xl border border-white/5 p-5 lg:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-cyan-400/10 rounded-lg"><Package className="w-5 h-5 text-cyan-400" /></div>
              <div>
                <h3 className="text-white font-semibold">Installed Modules</h3>
                <p className="text-xs text-gray-500">List all installed Odoo modules from database</p>
              </div>
            </div>
            <button
              onClick={() => runAction("installed-modules")}
              disabled={actionLoading === "installed-modules"}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {actionLoading === "installed-modules" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Show Modules"}
            </button>
          </div>

          {/* Action Result */}
          {actionResult && (
            <div className="lg:col-span-2 bg-[var(--card)] rounded-xl border border-white/5 p-4">
              {actionResult.error ? (
                <div className="flex items-start gap-3 text-red-400">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <pre className="text-sm whitespace-pre-wrap">{actionResult.error}</pre>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-emerald-400">
                  <Check className="w-5 h-5" />
                  <span className="text-sm">
                    {actionResult.affected_rows > 0
                      ? `${actionResult.affected_rows} row(s) affected`
                      : actionResult.rows.length > 0
                        ? `Found: ${actionResult.rows.map(r => r.join(", ")).join(" | ")}`
                        : "Operation completed"}
                    {" "}({actionResult.execution_time_ms}ms)
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Active Users Result */}
          {activeUsers && activeUsers.columns.length > 0 && (
            <div className="lg:col-span-2 bg-[var(--card)] rounded-xl border border-white/5 overflow-hidden">
              <div className="px-4 py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">{activeUsers.row_count} active users</span>
              </div>
              <div className="overflow-auto max-h-[400px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--card)]">
                    <tr className="border-b border-white/10">
                      {activeUsers.columns.map(col => (
                        <th key={col} className="px-3 py-2 text-left text-xs font-medium text-gray-400">{col}</th>
                      ))}
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeUsers.rows.map((row, i) => {
                      const uid = parseInt(row[0]);
                      const isActive = row[4] === "t" || row[4] === "true";
                      return (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                          {row.map((cell, j) => (
                            <td key={j} className="px-3 py-1.5 text-gray-300 text-xs">{cell?.toString() || "-"}</td>
                          ))}
                          <td className="px-3 py-1.5 text-right">
                            {uid > 2 && (
                              <button
                                onClick={() => runAction("toggle-user", { userId: uid, active: !isActive })}
                                className={`text-xs px-2 py-0.5 rounded ${isActive ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"}`}
                              >
                                {isActive ? "Disable" : "Enable"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Installed Modules Result */}
          {installedModules && installedModules.columns.length > 0 && (
            <div className="lg:col-span-2 bg-[var(--card)] rounded-xl border border-white/5 overflow-hidden">
              <div className="px-4 py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">{installedModules.row_count} installed modules</span>
              </div>
              <div className="overflow-auto max-h-[400px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--card)]">
                    <tr className="border-b border-white/10">
                      {installedModules.columns.map(col => (
                        <th key={col} className="px-3 py-2 text-left text-xs font-medium text-gray-400">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {installedModules.rows.map((row, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                        {row.map((cell, j) => (
                          <td key={j} className="px-3 py-1.5 text-gray-300 text-xs truncate max-w-[200px]">{cell?.toString() || "-"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ STATISTICS ═══ */}
      {subTab === "stats" && (
        <div className="space-y-4">
          {statsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
            </div>
          ) : stats ? (
            <>
              {/* Stats cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[var(--card)] rounded-xl border border-white/5 p-4">
                  <div className="text-xs text-gray-500 mb-1">Database Size</div>
                  <div className="text-2xl font-bold text-white">{stats.db_size}</div>
                  <div className="text-xs text-gray-600 mt-1">{stats.db_name}</div>
                </div>
                <div className="bg-[var(--card)] rounded-xl border border-white/5 p-4">
                  <div className="text-xs text-gray-500 mb-1">Total Tables</div>
                  <div className="text-2xl font-bold text-white">{stats.total_tables}</div>
                  <div className="text-xs text-gray-600 mt-1">{stats.total_rows.toLocaleString()} rows</div>
                </div>
                <div className="bg-[var(--card)] rounded-xl border border-white/5 p-4">
                  <div className="text-xs text-gray-500 mb-1">Active Connections</div>
                  <div className="text-2xl font-bold text-white">{stats.active_connections}</div>
                  <div className="text-xs text-gray-600 mt-1">PostgreSQL {stats.pg_version}</div>
                </div>
                <div className="bg-[var(--card)] rounded-xl border border-white/5 p-4">
                  <div className="text-xs text-gray-500 mb-1">Cache Hit Ratio</div>
                  <div className={`text-2xl font-bold ${stats.cache_hit_ratio >= 99 ? "text-emerald-400" : stats.cache_hit_ratio >= 95 ? "text-amber-400" : "text-red-400"}`}>
                    {stats.cache_hit_ratio}%
                  </div>
                  <div className="text-xs text-gray-600 mt-1">{stats.cache_hit_ratio >= 99 ? "Excellent" : stats.cache_hit_ratio >= 95 ? "Good" : "Needs tuning"}</div>
                </div>
              </div>

              {/* Largest tables */}
              <div className="bg-[var(--card)] rounded-xl border border-white/5">
                <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                  <h3 className="text-white font-semibold flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-[var(--accent)]" />
                    Top 10 Largest Tables
                  </h3>
                  <button onClick={loadStats} className="text-gray-500 hover:text-white">
                    <RefreshCw className={`w-4 h-4 ${statsLoading ? "animate-spin" : ""}`} />
                  </button>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400">Table</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-400">Rows</th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-400">Size</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 w-1/3">Distribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.largest_tables.map((t, i) => {
                        const maxRows = Math.max(...stats.largest_tables.map(lt => lt.rows));
                        const pct = maxRows > 0 ? (t.rows / maxRows) * 100 : 0;
                        return (
                          <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                            <td className="px-4 py-2">
                              <button
                                onClick={() => { setSubTab("browser"); setTimeout(() => selectTable(t.name), 100); }}
                                className="text-[var(--accent)] hover:underline font-mono text-xs"
                              >
                                {t.name}
                              </button>
                            </td>
                            <td className="px-4 py-2 text-right text-gray-300 tabular-nums">{t.rows.toLocaleString()}</td>
                            <td className="px-4 py-2 text-right text-gray-400">{t.size}</td>
                            <td className="px-4 py-2">
                              <div className="w-full bg-white/5 rounded-full h-2">
                                <div
                                  className="bg-[var(--accent)] rounded-full h-2 transition-all"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center py-12 text-gray-500">
              Failed to load statistics
            </div>
          )}
        </div>
      )}

      {/* ═══ INSERT MODAL ═══ */}
      {showInsertModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setShowInsertModal(false)}>
          <div className="bg-[var(--card)] rounded-xl border border-white/10 w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <h3 className="text-white font-semibold">Insert Record into {selectedTable}</h3>
              <button onClick={() => setShowInsertModal(false)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {Object.entries(insertValues).map(([col, val]) => {
                const colInfo = columns.find(c => c.name === col);
                return (
                  <div key={col}>
                    <label className="block text-xs text-gray-400 mb-1">
                      {colInfo?.odoo_label || col}
                      <span className="text-gray-600 ml-1.5">({colInfo?.data_type})</span>
                      {colInfo?.is_nullable && <span className="text-gray-600 ml-1">nullable</span>}
                    </label>
                    <input
                      type="text"
                      value={val}
                      onChange={e => setInsertValues(prev => ({ ...prev, [col]: e.target.value }))}
                      placeholder={colInfo?.default_value || ""}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/5">
              <button onClick={() => setShowInsertModal(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">
                Cancel
              </button>
              <button
                onClick={doInsert}
                disabled={insertSaving}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {insertSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Insert Record
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
