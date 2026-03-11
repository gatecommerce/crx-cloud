"use client";

import { useState } from "react";

export function VitoChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <>
      {/* Chat toggle button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
        >
          <span className="text-lg font-bold">V</span>
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 h-[500px] bg-[var(--card)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-[var(--accent)] rounded-full flex items-center justify-center text-sm font-bold">
                V
              </div>
              <div>
                <div className="text-sm font-semibold">Vito</div>
                <div className="text-xs text-[var(--success)]">online</div>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-[var(--muted)] hover:text-[var(--foreground)] text-lg"
            >
              x
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="bg-[var(--background)] rounded-lg p-3 text-sm mb-3 max-w-[80%]">
              Ciao! Sono Vito, il tuo assistente AI. Posso aiutarti a gestire server, deployare CMS,
              analizzare problemi e molto altro. Cosa ti serve?
            </div>
          </div>

          {/* Input */}
          <div className="p-3 border-t border-[var(--border)]">
            <div className="flex gap-2">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Chiedi a Vito..."
                className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
              <button className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors">
                Invia
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
