export function StatsBar() {
  const stats = [
    { label: "Servers", value: "3", status: "online" },
    { label: "Instances", value: "7", status: "running" },
    { label: "Backups Today", value: "12", status: "ok" },
    { label: "Alerts", value: "1", status: "warning" },
  ];

  return (
    <header className="border-b border-[var(--border)] bg-[var(--card)] px-6 py-3">
      <div className="flex items-center gap-8">
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                stat.status === "warning" ? "bg-[var(--warning)]" : "bg-[var(--success)]"
              }`}
            />
            <span className="text-sm text-[var(--muted)]">{stat.label}</span>
            <span className="text-sm font-semibold">{stat.value}</span>
          </div>
        ))}

        <div className="ml-auto text-xs text-[var(--muted)]">
          cloud.crx.team
        </div>
      </div>
    </header>
  );
}
