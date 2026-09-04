/** Redacted shapes observed from exact Codex 0.150.1 config/read, not AR's internal policy model. */
export const codexUserPermissionProfile = (codexHome: string, mode: "analysis" | "workspace-write" = "analysis") => ({
  extends: mode === "analysis" ? ":read-only" : ":workspace",
  filesystem: { [codexHome]: "deny", ":tmpdir": "read", ":slash_tmp": "read" },
  network: { enabled: false },
});

export const codexEffectivePermissionProfile = (codexHome: string, mode: "analysis" | "workspace-write" = "analysis") => ({
  description: null,
  extends: mode === "analysis" ? ":read-only" : ":workspace",
  filesystem: { [codexHome]: "deny", ":tmpdir": "read", ":slash_tmp": "read", glob_scan_max_depth: null },
  network: {
    allow_local_binding: null, allow_upstream_proxy: null,
    dangerously_allow_all_unix_sockets: null, dangerously_allow_non_loopback_proxy: null,
    domains: null, enable_socks5: null, enable_socks5_udp: null, enabled: false,
    mitm: null, mode: null, proxy_url: null, socks_url: null, unix_sockets: null,
  },
  workspace_roots: null,
});
