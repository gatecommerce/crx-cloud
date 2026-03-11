"use client";

const mockServers = [
  {
    id: "srv-01",
    name: "production-aks",
    type: "kubernetes",
    provider: "Azure AKS",
    status: "online",
    cpu: 34,
    ram: 62,
    instances: [
      { name: "Odoo 18", cms: "odoo", status: "running" },
      { name: "WP Blog", cms: "wordpress", status: "running" },
    ],
  },
  {
    id: "srv-02",
    name: "hetzner-eu",
    type: "vm",
    provider: "Hetzner",
    status: "online",
    cpu: 58,
    ram: 71,
    instances: [
      { name: "PrestaShop Store", cms: "prestashop", status: "running" },
    ],
  },
  {
    id: "srv-03",
    name: "dev-k3s",
    type: "kubernetes",
    provider: "Custom K3s",
    status: "offline",
    cpu: 0,
    ram: 0,
    instances: [],
  },
];

const statusColors: Record<string, string> = {
  online: "bg-[var(--success)]",
  offline: "bg-[var(--danger)]",
  running: "bg-[var(--success)]",
  stopped: "bg-[var(--muted)]",
};

const cmsIcons: Record<string, string> = {
  odoo: "O",
  wordpress: "W",
  prestashop: "P",
  woocommerce: "WC",
};

export function ServerList() {
  return (
    <div className="grid gap-4">
      {mockServers.map((server) => (
        <div
          key={server.id}
          className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-5 hover:border-[var(--accent)]/30 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-2.5 h-2.5 rounded-full ${statusColors[server.status]}`} />
              <h3 className="font-semibold">{server.name}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--border)] text-[var(--muted)]">
                {server.type === "kubernetes" ? "K8s" : "VM"}
              </span>
            </div>
            <span className="text-xs text-[var(--muted)]">{server.provider}</span>
          </div>

          {/* Metrics */}
          {server.status === "online" && (
            <div className="flex gap-6 mb-4">
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--muted)]">CPU</span>
                  <span>{server.cpu}%</span>
                </div>
                <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full transition-all"
                    style={{ width: `${server.cpu}%` }}
                  />
                </div>
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-[var(--muted)]">RAM</span>
                  <span>{server.ram}%</span>
                </div>
                <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent)] rounded-full transition-all"
                    style={{ width: `${server.ram}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Instances */}
          {server.instances.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {server.instances.map((inst) => (
                <span
                  key={inst.name}
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-[var(--background)] border border-[var(--border)]"
                >
                  <span className="font-mono font-bold text-[var(--accent)]">
                    {cmsIcons[inst.cms] || "?"}
                  </span>
                  {inst.name}
                  <span className={`w-1.5 h-1.5 rounded-full ${statusColors[inst.status]}`} />
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
