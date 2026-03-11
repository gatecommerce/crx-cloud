"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/api";
import { setToken, setUser } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isRegister) {
        await authApi.register(email, password, fullName);
      }
      const { access_token } = await authApi.login(email, password);
      setToken(access_token);
      const user = await authApi.me();
      setUser(user);
      router.push("/");
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
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

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-center">
            {isRegister ? "Create Account" : "Sign In"}
          </h2>

          {error && (
            <div className="text-sm text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {isRegister && (
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--muted)] mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              required
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--muted)] mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              required
              minLength={6}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? "..." : isRegister ? "Create Account" : "Sign In"}
          </button>

          <p className="text-center text-xs text-[var(--muted)]">
            {isRegister ? "Already have an account?" : "Don't have an account?"}{" "}
            <button
              type="button"
              onClick={() => { setIsRegister(!isRegister); setError(""); }}
              className="text-[var(--accent)] hover:underline"
            >
              {isRegister ? "Sign In" : "Register"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
