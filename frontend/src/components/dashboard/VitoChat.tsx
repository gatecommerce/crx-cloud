"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { vitoApi } from "@/lib/api";
import { Send, X, Bot, User } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
}

export function VitoChat() {
  const t = useTranslations("vito");
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: t("greeting"),
    },
  ]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(text?: string) {
    const msg = text || message.trim();
    if (!msg || loading) return;

    setMessage("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);

    try {
      const response = await vitoApi.chat(msg, { panel: "crx-cloud" });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.reply,
          suggestions: response.suggestions,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: t("error") },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 z-50"
        >
          <Bot size={24} />
        </button>
      )}

      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 h-[500px] bg-[var(--card)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--accent)]/5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-[var(--accent)] rounded-full flex items-center justify-center">
                <Bot size={16} />
              </div>
              <div>
                <div className="text-sm font-semibold">{t("name")}</div>
                <div className="text-xs text-[var(--success)]">{t("online")}</div>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-[var(--muted)] hover:text-[var(--foreground)]">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                {msg.role === "assistant" && (
                  <Bot size={20} className="text-[var(--accent)] shrink-0 mt-1" />
                )}
                <div
                  className={`rounded-lg p-3 text-sm max-w-[80%] ${
                    msg.role === "user"
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--background)] border border-[var(--border)]"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {msg.suggestions.map((s, j) => (
                        <button
                          key={j}
                          onClick={() => handleSend(s)}
                          className="text-xs px-2 py-1 rounded-md bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {msg.role === "user" && (
                  <User size={20} className="text-[var(--muted)] shrink-0 mt-1" />
                )}
              </div>
            ))}
            {loading && (
              <div className="flex gap-2">
                <Bot size={20} className="text-[var(--accent)] shrink-0 mt-1" />
                <div className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-2 h-2 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-2 h-2 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-3 border-t border-[var(--border)]">
            <div className="flex gap-2">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("placeholder")}
                className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                disabled={loading}
              />
              <button
                onClick={() => handleSend()}
                disabled={loading || !message.trim()}
                className="px-3 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded-lg transition-colors"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
