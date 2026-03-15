"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Send, Terminal } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("login");
  const [checking, setChecking] = useState(true);
  const [devLoading, setDevLoading] = useState(false);
  const [showDevLogin, setShowDevLogin] = useState(false);

  useEffect(() => {
    fetch("/api/v1/auth/session", { credentials: "include" })
      .then((res) => {
        if (res.ok) {
          router.replace("/");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));

    fetch("/api/v1/auth/dev-check")
      .then((res) => { if (res.ok) setShowDevLogin(true); })
      .catch(() => {});
  }, [router]);

  const handleDevLogin = async () => {
    setDevLoading(true);
    try {
      const res = await fetch("/api/v1/auth/dev-token", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        router.replace("/");
      } else {
        alert(t("devLoginFailed"));
        setDevLoading(false);
      }
    } catch {
      alert(t("cannotReachBackend"));
      setDevLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[var(--accent)] rounded-2xl mb-4">
            <span className="text-2xl font-bold">CRX</span>
          </div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-[var(--muted)] mt-1">{t("subtitle")}</p>
        </div>

        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 text-center">
          <h2 className="text-lg font-semibold mb-2">{t("telegramLogin")}</h2>
          <p className="text-sm text-[var(--muted)] mb-6">{t("telegramDescription")}</p>

          <a
            href="https://t.me/crx_vito_bot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#2AABEE] hover:bg-[#229ED9] rounded-lg text-sm font-medium transition-colors text-white"
          >
            <Send size={18} />
            {t("openTelegram")}
          </a>

          {showDevLogin && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <button
                onClick={handleDevLogin}
                disabled={devLoading}
                className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--warning)] hover:opacity-90 rounded-lg text-sm font-medium transition-colors text-black disabled:opacity-50"
              >
                <Terminal size={18} />
                {devLoading ? t("devLoading") : t("devLogin")}
              </button>
              <p className="text-xs text-[var(--muted)] mt-2">{t("devOnly")}</p>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-[var(--border)]">
            <p className="text-xs text-[var(--muted)]">
              {t("botInfo")}
              <br />
              {t("linkExpiry")}
            </p>
          </div>
        </div>

        <div className="mt-4 text-center">
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--muted)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {t("secureConnection")}
          </div>
        </div>
      </div>
    </div>
  );
}
