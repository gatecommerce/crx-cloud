"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";

interface UserSession {
  telegram_id: number;
  name: string;
  is_admin: boolean;
  lang: string;
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);

  useEffect(() => {
    authApi
      .session()
      .then((session) => {
        setUser(session);
        setChecked(true);
      })
      .catch(() => {
        router.replace("/login");
      });
  }, [router]);

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
        <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
