"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
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

// ─── Provider icons ─────────────────────────────────────────────────────────
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
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [storages, setStorages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formProvider, setFormProvider] = useState("s3");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const providerLabels: Record<string, string> = {
    s3: t("backupStorages.providers.s3"),
    azure: t("backupStorages.providers.azure"),
    gcs: t("backupStorages.providers.gcs"),
    local: t("backupStorages.providers.local"),
  };

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
    if (!confirm(t("backupStorages.confirmRemove"))) return;
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
      { key: "bucket", label: t("backupStorages.fields.bucket") },
      { key: "region", label: t("backupStorages.fields.region") },
      { key: "access_key", label: t("backupStorages.fields.accessKey") },
      { key: "secret_key", label: t("backupStorages.fields.secretKey"), type: "password" },
    ],
    azure: [
      { key: "container", label: t("backupStorages.fields.container") },
      { key: "account_name", label: t("backupStorages.fields.accountName") },
      { key: "sas_token", label: t("backupStorages.fields.sasToken"), type: "password" },
    ],
    gcs: [
      { key: "bucket", label: t("backupStorages.fields.bucket") },
      { key: "project_id", label: t("backupStorages.fields.projectId") },
      { key: "service_account_key", label: t("backupStorages.fields.serviceAccountKey") },
    ],
    local: [{ key: "path", label: t("backupStorages.fields.path") }],
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
                    <th className="text-left px-4 py-3">{t("backupStorages.name")}</th>
                    <th className="text-left px-4 py-3">{t("backupStorages.provider")}</th>
                    <th className="text-left px-4 py-3">{t("backupStorages.backups")}</th>
                    <th className="text-left px-4 py-3">{t("backupStorages.size")}</th>
                    <th className="text-right px-4 py-3">{t("backupStorages.status")}</th>
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
                                <CheckCircle size={14} /> {tc("active")}
                              </span>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleActivate(s.id)}
                                  className="text-xs px-2.5 py-1 rounded-md bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
                                >
                                  {t("backupStorages.setActive")}
                                </button>
                                <button
                                  onClick={() => handleDelete(s.id)}
                                  className="text-xs px-2.5 py-1 rounded-md bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/20 transition-colors"
                                >
                                  {tc("remove")}
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
              {t("backupStorages.empty")}
            </p>
          )}

          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Plus size={16} /> {tc("add")}
            </button>
          ) : (
            <form
              onSubmit={handleCreate}
              className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-4 space-y-3"
            >
              <h4 className="text-sm font-semibold mb-2">{t("backupStorages.newStorage")}</h4>

              {error && (
                <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">{tc("name")}</label>
                  <input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className={inputClass}
                    placeholder={t("backupStorages.placeholder")}
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">{t("backupStorages.provider")}</label>
                  <select
                    value={formProvider}
                    onChange={(e) => {
                      setFormProvider(e.target.value);
                      setFormConfig({});
                    }}
                    className={inputClass}
                  >
                    <option value="s3">{t("backupStorages.providers.s3")}</option>
                    <option value="azure">{t("backupStorages.providers.azure")}</option>
                    <option value="gcs">{t("backupStorages.providers.gcs")}</option>
                    <option value="local">{t("backupStorages.providers.local")}</option>
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
                  {saving ? tc("saving") : tc("save")}
                </button>
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  {tc("cancel")}
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
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const locale = useLocale();
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
    if (!confirm(t("apiKeys.confirmDelete"))) return;
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
    return new Date(iso).toLocaleDateString(locale, {
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
        {t("apiKeys.description")}
      </p>

      {/* Newly created key banner */}
      {newKey && (
        <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle size={16} className="text-[var(--warning)] shrink-0 mt-0.5" />
            <span className="text-sm font-medium text-[var(--warning)]">
              {t("apiKeys.saveWarning")}
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
            {tc("cancel")}
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
                    <th className="text-left px-4 py-3">{t("apiKeys.name")}</th>
                    <th className="text-left px-4 py-3">{t("apiKeys.key")}</th>
                    <th className="text-left px-4 py-3">{t("apiKeys.status")}</th>
                    <th className="text-left px-4 py-3">{t("apiKeys.created")}</th>
                    <th className="text-right px-4 py-3">{tc("actions")}</th>
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
                          title={k.is_active ? t("apiKeys.deactivate") : t("apiKeys.activate")}
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
                            {k.is_active ? tc("active") : t("apiKeys.status")}
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
                          title={t("apiKeys.deleteKey")}
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
              {t("apiKeys.empty")}
            </p>
          )}

          {!showForm ? (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              <Plus size={16} /> {tc("generate")}
            </button>
          ) : (
            <form
              onSubmit={handleCreate}
              className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-4 space-y-3"
            >
              <h4 className="text-sm font-semibold mb-2">{t("apiKeys.generateKey")}</h4>

              {error && (
                <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">{tc("name")}</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className={inputClass}
                  placeholder={t("apiKeys.namePlaceholder")}
                  required
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? tc("generating") : t("apiKeys.generateKey")}
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
                  {tc("cancel")}
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
  const t = useTranslations("settings");
  const tc = useTranslations("common");
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
    const typed = prompt(t("account.typeDelete"));
    if (typed !== "DELETE") {
      setConfirmDelete(false);
      return;
    }
    setDeleting(true);
    try {
      // The endpoint would handle account deletion
      alert(t("account.accountDeletionNotAvailable"));
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
            <InfoCard label={t("account.telegramId")} value={account.telegram_id || "-"} />
            <InfoCard label={t("account.name")} value={account.name || "-"} />
            <InfoCard label={t("account.language")} value={account.lang || account.language || "-"} />
            <InfoCard label={t("account.role")} value={account.is_admin ? t("account.admin") : t("account.user")} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard label={t("account.servers")} value={account.servers_count ?? account.stats?.servers ?? 0} />
            <StatCard label={t("account.instances")} value={account.instances_count ?? account.stats?.instances ?? 0} />
            <StatCard label={t("account.backups")} value={account.backups_count ?? account.stats?.backups ?? 0} />
          </div>

          {/* Danger zone */}
          <div className="mt-6 pt-4 border-t border-[var(--border)]">
            <h4 className="text-sm font-semibold text-[var(--danger)] mb-2 flex items-center gap-2">
              <Shield size={14} /> {t("account.dangerZone")}
            </h4>
            <p className="text-xs text-[var(--muted)] mb-3">
              {t("account.dangerDescription")}
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
                ? tc("saving")
                : confirmDelete
                ? t("account.confirmDeleteAccount")
                : t("account.deleteAccount")}
            </button>
            {confirmDelete && (
              <button
                onClick={() => setConfirmDelete(false)}
                className="ml-3 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                {tc("cancel")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-[var(--muted)]">{t("account.unableToLoad")}</p>
      )}
    </div>
  );
}

// ─── Enterprise Edition Section ──────────────────────────────────────────────
function EnterpriseSection() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [packages, setPackages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [detectedVersion, setDetectedVersion] = useState("");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);

  function detectVersionFromFilename(name: string): string {
    const m = name.match(/(\d+\.\d+)/);
    if (m && ["15.0","16.0","17.0","18.0","19.0","20.0"].includes(m[1])) return m[1];
    return "";
  }

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
    setSuccessMsg("");
    try {
      const result = await settingsApi.uploadEnterprise(uploadFile);
      setUploadFile(null);
      setShowUploadModal(false);
      setSuccessMsg(t("enterprise.uploadSuccess", { version: result.version, size: result.size_mb }));
      loadPackages();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(version: string) {
    if (!confirm(t("enterprise.confirmDelete", { version }))) return;
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
    return new Date(iso).toLocaleDateString(locale, {
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
        {t("enterprise.description")}
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
                    <th className="text-left px-4 py-3">{t("enterprise.version")}</th>
                    <th className="text-left px-4 py-3">{t("enterprise.packageRevision")}</th>
                    <th className="text-left px-4 py-3">{t("enterprise.uploaded")}</th>
                    <th className="text-left px-4 py-3">{tc("size")}</th>
                    <th className="text-right px-4 py-3">{tc("actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {packages.map((pkg) => (
                    <tr
                      key={pkg.version}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--card-hover)]"
                    >
                      <td className="px-4 py-3 text-sm font-medium">Odoo {pkg.version}</td>
                      <td className="px-4 py-3 text-sm">
                        {pkg.revision_date ? (
                          <span className="px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-mono text-xs">{pkg.revision_date}</span>
                        ) : (
                          <span className="text-[var(--muted)]">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {formatDate(pkg.uploaded_at)}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--muted)]">
                        {pkg.size_mb ? `${pkg.size_mb} MB` : "-"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleDelete(pkg.version)}
                          className="text-[var(--muted)] hover:text-[var(--danger)] transition-colors"
                          title={t("enterprise.confirmDelete", { version: pkg.version })}
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
              {t("enterprise.empty")}
            </p>
          )}

          {successMsg && (
            <div className="text-sm text-[var(--success)] bg-[var(--success)]/10 rounded-lg px-3 py-2 mb-4 flex items-center gap-2">
              <CheckCircle size={14} /> {successMsg}
            </div>
          )}

          <button
            onClick={() => { setShowUploadModal(true); setError(""); setSuccessMsg(""); setUploadFile(null); setDetectedVersion(""); }}
            className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Upload size={16} /> {t("enterprise.uploadSources")}
          </button>

          {/* Upload Modal */}
          {showUploadModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => !uploading && setShowUploadModal(false)}>
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-lg font-semibold">{t("enterprise.uploadTitle")}</h3>
                  <button onClick={() => !uploading && setShowUploadModal(false)} className="text-[var(--muted)] hover:text-[var(--foreground)] text-xl leading-none">&times;</button>
                </div>

                <ol className="text-sm text-[var(--muted)] space-y-2 mb-5 list-decimal list-inside">
                  <li>{t("enterprise.uploadStep1")}</li>
                  <li>{t("enterprise.uploadStep2")}</li>
                  <li>{t("enterprise.uploadStep3")}</li>
                  <li>{t("enterprise.uploadStep4")}</li>
                  <li>{t("enterprise.uploadStep5")}</li>
                </ol>

                {error && (
                  <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 rounded-lg px-3 py-2 mb-4">
                    {error}
                  </div>
                )}

                <form onSubmit={handleUpload} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1.5">{t("enterprise.file")}</label>
                    <input
                      type="file"
                      accept=".tar.gz,.zip,.tgz"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        setUploadFile(f);
                        setDetectedVersion(f ? detectVersionFromFilename(f.name) : "");
                        setError("");
                      }}
                      className={`${inputClass} file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:bg-[var(--accent)]/10 file:text-[var(--accent)]`}
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1.5">{t("enterprise.version")}</label>
                    <input
                      type="text"
                      value={detectedVersion}
                      readOnly
                      placeholder={t("enterprise.autoDetected")}
                      className={`${inputClass} bg-[var(--card)] text-[var(--muted)]`}
                    />
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowUploadModal(false)}
                      disabled={uploading}
                      className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      {tc("cancel")}
                    </button>
                    <button
                      type="submit"
                      disabled={uploading || !uploadFile}
                      className="px-5 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                    >
                      {uploading ? (
                        <><Loader2 size={14} className="animate-spin" /> {tc("saving")}</>
                      ) : (
                        <><Upload size={14} /> {tc("save")}</>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
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
  const t = useTranslations("settings");

  return (
    <AuthGuard>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <StatsBar />
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-5xl mx-auto">
              <h1 className="text-2xl font-bold mb-6">{t("title")}</h1>

              <div className="space-y-4">
                <AccordionSection title={t("backupStorages.title")} icon={HardDrive} defaultOpen>
                  <BackupStoragesSection />
                </AccordionSection>

                <AccordionSection title={t("enterprise.title")} icon={Shield}>
                  <EnterpriseSection />
                </AccordionSection>

                <AccordionSection title={t("apiKeys.title")} icon={Key}>
                  <ApiKeysSection />
                </AccordionSection>

                <AccordionSection title={t("account.title")} icon={UserCog}>
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
