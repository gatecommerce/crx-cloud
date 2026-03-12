"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";
import { settingsApi } from "@/lib/api";
import {
  ChevronDown, ChevronRight, Plus, Trash2, Search, Copy,
  CheckCircle, Cloud, HardDrive, Key, UserCog, AlertTriangle,
  Shield, ToggleLeft, ToggleRight, Loader2, Upload
} from "lucide-react";

// ─── Provider icons/labels ───────────────────────────────────────────────────
const providerLabels: Record<string, string> = {
  s3: "Amazon S3",
  azure: "Azure Blob",
  gcs: "Google Cloud Storage",
  local: "Local Storage",
};

const providerIcons: Record<string, any> = {
  s3: Cloud,
  azure: Cloud,
  gcs: Cloud,
  local: HardDrive,
};

// ─── Accordion wrapper ──────────────────────────────────────────────────────
function AccordionSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: any;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden border-l-4 border-l-[var(--accent)]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-[var(--card-hover)] transition-colors"
      >
        {open ? (
          <ChevronDown size={18} className="text-[var(--accent)] shrink-0" />
        ) : (
          <ChevronRight size={18} className="text-[var(--accent)] shrink-0" />
        )}
        <Icon size={18} className="text-[var(--accent)] shrink-0" />
        <span className="text-[var(--accent)] font-semibold text-sm">{title}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-5 py-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Backup Storages Section ─────────────────────────────────────────────────
function BackupStoragesSection() {
  const [storages, setStorages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formProvider, setFormProvider] = useState("s3");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadStorages = useCallback(async () => {
    try {
      const data = await settingsApi.listBackupStorages().catch(() => []);
      setStorages(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStorages();
  }, [loadStorages]);

  function resetForm() {
    setFormName("");
    setFormProvider("s3");
    setFormConfig({});
    setShowForm(false);
    setError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await settingsApi.createBackupStorage({
        name: formName,
        provider: formProvider,
        config: formConfig,
      });
      resetForm();
      loadStorages();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(id: string) {
    try {
      await settingsApi.activateBackupStorage(id);
      loadStorages();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this backup storage?")) return;
    try {
      await settingsApi.deleteBackupStorage(id);
      loadStorages();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function updateConfig(key: string, value: string) {
    setFormConfig((prev) => ({ ...prev, [key]: value }));
  }

  const providerFields: Record<string, { key: string; label: string; type?: string }[]> = {
    s3: [
      { key: "bucket", label: "Bucket" },
      { key: "region", label: "Region" },
      { key: "access_key", label: "Access Key" },
      { key: "secret_key", label: "Secret Key", type: "password" },
    ],
    azure: [
      { key: "container", label: "Container" },
      { key: "account_name", label: "Account Name" },
      { key: "sas_token", label: "SAS Token", type: "password" },
    ],
    gcs: [
      { key: "bucket", label: "Bucket" },
      { key: "project_id", label: "Project ID" },
      { key: "service_account_key", label: "Service Account Key (JSON)" },
    ],
    local: [{ key: "path", label: "Path" }],
  };

  const inputClass =
    "w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]";

  return (
    <div>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {storages.length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                    <th className="text-left px-4 py-3">Name</th>
                    <th className="text-left px-4 py-3">Provider</th>
                    <th className="text-left px-4 py-3">Backups</th>
                    <th className="text-left px-4 py-3">Size</th>
                    <th className="text-right px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {storages.map((s) => {
                    const ProvIcon = providerIcons[s.provider] || Cloud;
                    return (
                      <tr
                        key={s.id}
                        className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]"
                      >
                        <td className="px-4 py-3 text-sm font-medium">{s.name}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                            <ProvIcon size={14} />
                            {providerLabels[s.provider] || s.provider}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
                            <span>{s.backup_count ?? 0}</span>
                            {s.backup_count > 0 && (
                              <span title="View backups">
                                <Search
                                  size={12}
                                  className="text-[var(--accent)] cursor-pointer hover:text-[var(--accent-hover)]"
                                />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-[var(--muted)]">
                          {s.total_size ? formatSize(s.total_size) : "-"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {s.is_active ? (
                              <span className="flex items-center gap-1 text-[var(--success)] text-xs font-medium">
                                <CheckCircle size={14} /> Active
                              </span>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleActivate(s.id)}
                                  className="text-xs px-2.5 py-1 rounded-md bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
                                >
                                  Set as active
                                </button>
                                <button
                                  onClick={() => handleDelete(s.id)}
                                  className="text-xs px-2.5 py-1 rounded-md bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/20 transition-colors"
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {storages.length === 0 && !showForm && (
            <p className="text-sm text-[var(--muted)] mb-4">
              No backup storages configured. Add one to enable remote backups.
            </p>
          )}

          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Plus size={16} /> Add
            </button>
          ) : (
            <form
              onSubmit={handleCreate}
              className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-4 space-y-3"
            >
              <h4 className="text-sm font-semibold mb-2">New Backup Storage</h4>

              {error && (
                <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Name</label>
                  <input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className={inputClass}
                    placeholder="My S3 Bucket"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Provider</label>
                  <select
                    value={formProvider}
                    onChange={(e) => {
                      setFormProvider(e.target.value);
                      setFormConfig({});
                    }}
                    className={inputClass}
                  >
                    <option value="s3">Amazon S3</option>
                    <option value="azure">Azure Blob</option>
                    <option value="gcs">Google Cloud Storage</option>
                    <option value="local">Local Storage</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {providerFields[formProvider]?.map((field) =>
                  field.key === "service_account_key" ? (
                    <div key={field.key} className="sm:col-span-2">
                      <label className="block text-xs text-[var(--muted)] mb-1">
                        {field.label}
                      </label>
                      <textarea
                        value={formConfig[field.key] || ""}
                        onChange={(e) => updateConfig(field.key, e.target.value)}
                        className={`${inputClass} h-24 resize-none font-mono text-xs`}
                        placeholder='{"type": "service_account", ...}'
                        required
                      />
                    </div>
                  ) : (
                    <div key={field.key}>
                      <label className="block text-xs text-[var(--muted)] mb-1">
                        {field.label}
                      </label>
                      <input
                        type={field.type || "text"}
                        value={formConfig[field.key] || ""}
                        onChange={(e) => updateConfig(field.key, e.target.value)}
                        className={inputClass}
                        required
                      />
                    </div>
                  )
                )}
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ─── API Keys Section ────────────────────────────────────────────────────────
function ApiKeysSection() {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const data = await settingsApi.listApiKeys().catch(() => []);
      setKeys(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await settingsApi.createApiKey(formName);
      setNewKey(result.key);
      setFormName("");
      setShowForm(false);
      loadKeys();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(id: string) {
    try {
      await settingsApi.toggleApiKey(id);
      loadKeys();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this API key? This action cannot be undone.")) return;
    try {
      await settingsApi.deleteApiKey(id);
      loadKeys();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  const inputClass =
    "w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]";

  return (
    <div>
      <p className="text-sm text-[var(--muted)] mb-4">
        API keys allow secure programmatic access to your CRX Cloud resources.
      </p>

      {/* Newly created key banner */}
      {newKey && (
        <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
            <span className="text-sm font-medium text-[var(--warning)]">
              Save this key — it won&apos;t be shown again
            </span>
          </div>
          <div className="flex items-center gap-2 bg-[var(--background)] rounded-md px-3 py-2 font-mono text-xs">
            <span className="flex-1 break-all select-all">{newKey}</span>
            <button
              onClick={() => copyToClipboard(newKey)}
              className="shrink-0 p-1 hover:text-[var(--accent)] transition-colors"
              title="Copy"
            >
              {copied ? <CheckCircle size={14} className="text-[var(--success)]" /> : <Copy size={14} />}
            </button>
          </div>
          <button
            onClick={() => setNewKey(null)}
            className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] mt-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {keys.length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                    <th className="text-left px-4 py-3">Name</th>
                    <th className="text-left px-4 py-3">Key</th>
                    <th className="text-left px-4 py-3">Status</th>
                    <th className="text-left px-4 py-3">Created</th>
                    <th className="text-right px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr
                      key={k.id}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]"
                    >
                      <td className="px-4 py-3 text-sm font-medium">{k.name}</td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)] font-mono">
                        {k.masked_key || `crx_****...${k.last4 || "****"}`}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleToggle(k.id)}
                          className="flex items-center gap-1.5"
                          title={k.is_active ? "Deactivate" : "Activate"}
                        >
                          {k.is_active ? (
                            <ToggleRight size={20} className="text-[var(--success)]" />
                          ) : (
                            <ToggleLeft size={20} className="text-[var(--muted)]" />
                          )}
                          <span
                            className={`text-xs font-medium ${
                              k.is_active ? "text-[var(--success)]" : "text-[var(--muted)]"
                            }`}
                          >
                            {k.is_active ? "Active" : "Inactive"}
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {k.created_at ? formatDate(k.created_at) : "-"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDelete(k.id)}
                          className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
                          title="Delete key"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {keys.length === 0 && !showForm && (
            <p className="text-sm text-[var(--muted)] mb-4">
              No API keys created yet.
            </p>
          )}

          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Plus size={16} /> Generate
            </button>
          ) : (
            <form
              onSubmit={handleCreate}
              className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-4 space-y-3"
            >
              <h4 className="text-sm font-semibold mb-2">Generate API Key</h4>

              {error && (
                <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Name</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className={inputClass}
                  placeholder="e.g. CI/CD Pipeline"
                  required
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? "Generating..." : "Generate Key"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setFormName("");
                    setError("");
                  }}
                  className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ─── Account Management Section ──────────────────────────────────────────────
function AccountSection() {
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    settingsApi
      .getAccount()
      .then(setAccount)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleDeleteAccount() {
    // Double confirmation
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const typed = prompt('Type "DELETE" to permanently delete your account:');
    if (typed !== "DELETE") {
      setConfirmDelete(false);
      return;
    }
    setDeleting(true);
    try {
      // The endpoint would handle account deletion
      alert("Account deletion requested. This feature is not yet available.");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {account ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <InfoCard label="Telegram ID" value={account.telegram_id || "-"} />
            <InfoCard label="Name" value={account.name || "-"} />
            <InfoCard label="Language" value={account.lang || account.language || "-"} />
            <InfoCard label="Role" value={account.is_admin ? "Admin" : "User"} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard label="Servers" value={account.servers_count ?? account.stats?.servers ?? 0} />
            <StatCard label="Instances" value={account.instances_count ?? account.stats?.instances ?? 0} />
            <StatCard label="Backups" value={account.backups_count ?? account.stats?.backups ?? 0} />
          </div>

          {/* Danger zone */}
          <div className="mt-6 pt-4 border-t border-[var(--border)]">
            <h4 className="text-sm font-semibold text-[var(--danger)] mb-2 flex items-center gap-2">
              <Shield size={14} /> Danger Zone
            </h4>
            <p className="text-xs text-[var(--muted)] mb-3">
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>
            <button
              onClick={handleDeleteAccount}
              disabled={deleting}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                confirmDelete
                  ? "bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
                  : "bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/20"
              }`}
            >
              <Trash2 size={14} />
              {deleting
                ? "Deleting..."
                : confirmDelete
                ? "Confirm Delete Account"
                : "Delete Account"}
            </button>
            {confirmDelete && (
              <button
                onClick={() => setConfirmDelete(false)}
                className="ml-3 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-[var(--muted)]">Unable to load account information.</p>
      )}
    </div>
  );
}

// ─── Enterprise Edition Section ──────────────────────────────────────────────
function EnterpriseSection() {
  const [packages, setPackages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadVersion, setUploadVersion] = useState("18.0");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  const loadPackages = useCallback(async () => {
    try {
      const data = await settingsApi.listEnterprise().catch(() => []);
      setPackages(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPackages();
  }, [loadPackages]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) return;
    setUploading(true);
    setError("");
    try {
      await settingsApi.uploadEnterprise(uploadVersion, uploadFile);
      setUploadFile(null);
      loadPackages();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(version: string) {
    if (!confirm(`Delete Enterprise package for Odoo ${version}?`)) return;
    try {
      await settingsApi.deleteEnterprise(version);
      loadPackages();
    } catch (err: any) {
      alert(err.message);
    }
  }

  function formatSize(bytes: number): string {
    if (!bytes) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function formatDate(iso: string) {
    if (!iso) return "-";
    return new Date(iso).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  const inputClass =
    "w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]";

  return (
    <div>
      <p className="text-sm text-[var(--muted)] mb-4">
        Upload Odoo Enterprise packages to enable Enterprise Edition on your instances.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {packages.length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-xs text-[var(--muted)]">
                    <th className="text-left px-4 py-3">Version</th>
                    <th className="text-left px-4 py-3">Revision Date</th>
                    <th className="text-left px-4 py-3">Size</th>
                    <th className="text-right px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((pkg) => (
                    <tr
                      key={pkg.version}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]"
                    >
                      <td className="px-4 py-3 text-sm font-medium">Odoo {pkg.version}</td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {formatDate(pkg.revision_date || pkg.uploaded_at)}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {formatSize(pkg.size)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDelete(pkg.version)}
                          className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
                          title="Delete package"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {packages.length === 0 && (
            <p className="text-sm text-[var(--muted)] mb-4">
              No Enterprise packages uploaded yet. Upload one to enable Enterprise Edition on your instances.
            </p>
          )}

          <form
            onSubmit={handleUpload}
            className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-4 space-y-3"
          >
            <h4 className="text-sm font-semibold mb-2">Upload Enterprise Package</h4>

            {error && (
              <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Odoo Version</label>
                <select
                  value={uploadVersion}
                  onChange={(e) => setUploadVersion(e.target.value)}
                  className={inputClass}
                >
                  <option value="17.0">17.0</option>
                  <option value="18.0">18.0</option>
                  <option value="19.0">19.0</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Package file (.tar.gz / .zip)</label>
                <input
                  type="file"
                  accept=".tar.gz,.zip,.tgz"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className={`${inputClass} file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-[var(--accent)]/10 file:text-[var(--accent)]`}
                  required
                />
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="submit"
                disabled={uploading || !uploadFile}
                className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
              >
                {uploading ? (
                  <><Loader2 size={14} className="animate-spin" /> Uploading...</>
                ) : (
                  <><Upload size={14} /> Upload</>
                )}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

// ─── Small helper components ─────────────────────────────────────────────────
function InfoCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 py-3">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="text-sm font-medium">{String(value)}</div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--background)] border border-[var(--border)] rounded-lg px-4 py-3 text-center">
      <div className="text-2xl font-bold text-[var(--accent)]">{value}</div>
      <div className="text-xs text-[var(--muted)] mt-1">{label}</div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function SettingsPage() {
  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-5xl mx-auto">
              <h1 className="text-2xl font-bold mb-6">Settings</h1>

              <div className="space-y-4">
                <AccordionSection title="Backup Storages" icon={HardDrive} defaultOpen>
                  <BackupStoragesSection />
                </AccordionSection>

                <AccordionSection title="Enterprise Edition" icon={Shield}>
                  <EnterpriseSection />
                </AccordionSection>

                <AccordionSection title="API Keys" icon={Key}>
                  <ApiKeysSection />
                </AccordionSection>

                <AccordionSection title="Account Management" icon={UserCog}>
                  <AccountSection />
                </AccordionSection>
              </div>
            </div>
          </main>
          <VitoChat />
        </div>
      </div>
    </AuthGuard>
  );
}
