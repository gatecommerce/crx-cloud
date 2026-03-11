import { Sidebar } from "@/components/dashboard/Sidebar";
import { ServerList } from "@/components/dashboard/ServerList";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { VitoChat } from "@/components/dashboard/VitoChat";

export default function Dashboard() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top stats bar */}
        <StatsBar />

        {/* Content area */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-bold">Servers</h1>
              <button className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg text-sm font-medium transition-colors">
                + Add Server
              </button>
            </div>
            <ServerList />
          </div>
        </main>

        {/* Vito chat widget */}
        <VitoChat />
      </div>
    </div>
  );
}
