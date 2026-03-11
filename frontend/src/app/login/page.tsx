"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Terminal } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [devLoading, setDevLoading] = useState(false);
  const [showDevLogin, setShowDevLogin] = useState(false);

  // Check if already authenticated + detect dev mode from backend
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

    // Check if backend is in dev mode
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
        alert("Dev login failed — backend non in modalita dev");
        setDevLoading(false);
      }
    } catch {
      alert("Cannot reach backend");
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
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-[var(--accent)] rounded-2xl mb-4">
            <span className="text-2xl font-bold">CRX</span>
          </div>
          <h1 className="text-2xl font-bold">CRX Cloud</h1>
          <p className="text-sm text-[var(--muted)] mt-1">AI-Powered Hosting Panel</p>
        </div>

        {/* Telegram Login */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 text-center">
          <h2 className="text-lg font-semibold mb-2">Accedi con Telegram</h2>
          <p className="text-sm text-[var(--muted)] mb-6">
            Accesso sicuro senza password. Apri il bot Telegram e clicca su &quot;CRX Cloud&quot; per ricevere il link di accesso.
          </p>

          {/* Telegram button */}
          <a
            href="https://t.me/crx_vito_bot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#2AABEE] hover:bg-[#229ED9] rounded-lg text-sm font-medium transition-colors text-white"
          >
            <Send size={18} />
            Apri Telegram Bot
          </a>

          {/* Dev login — appears only if backend is in dev mode */}
          {showDevLogin && (
            <div className="mt-4 pt-4 border-t border-[var(--border)]">
              <button
                onClick={handleDevLogin}
                disabled={devLoading}
                className="inline-flex items-center gap-2 px-6 py-3 bg-[var(--warning)] hover:opacity-90 rounded-lg text-sm font-medium transition-colors text-black disabled:opacity-50"
              >
                <Terminal size={18} />
                {devLoading ? "Accesso..." : "Dev Login (Test)"}
              </button>
              <p className="text-xs text-[var(--muted)] mt-2">
                Solo in ambiente di sviluppo
              </p>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-[var(--border)]">
            <p className="text-xs text-[var(--muted)]">
              Il bot ti inviera un link sicuro per accedere al pannello.
              <br />
              Il link scade dopo 60 minuti e puo essere usato una sola volta.
            </p>
          </div>
        </div>

        {/* Security info */}
        <div className="mt-4 text-center">
          <div className="flex items-center justify-center gap-2 text-xs text-[var(--muted)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Connessione sicura — nessuna password salvata
          </div>
        </div>
      </div>
    </div>
  );
}
