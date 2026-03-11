"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"validating" | "error">("validating");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setErrorMsg("Token mancante o non valido. Richiedi un nuovo link dal bot Telegram.");
      return;
    }

    fetch("/api/v1/auth/token", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          // Session cookie is set automatically by the backend
          router.replace(data.redirect || "/");
        } else {
          setStatus("error");
          setErrorMsg("Token scaduto o non valido. Richiedi un nuovo link dal bot Telegram.");
        }
      })
      .catch(() => {
        setStatus("error");
        setErrorMsg("Errore di connessione. Riprova tra qualche secondo.");
      });
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--background)]">
      <div className="text-center max-w-md px-6">
        {status === "validating" ? (
          <div>
            <div className="w-10 h-10 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[var(--muted)]">Verifica accesso in corso...</p>
          </div>
        ) : (
          <div className="bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-xl p-6">
            <div className="w-12 h-12 rounded-full bg-[var(--danger)]/20 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">!</span>
            </div>
            <p className="text-sm text-[var(--danger)] mb-4">{errorMsg}</p>
            <a
              href="/login"
              className="inline-block px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors"
            >
              Torna al login
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-[var(--background)]">
          <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <AuthContent />
    </Suspense>
  );
}
