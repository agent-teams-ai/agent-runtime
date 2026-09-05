/** Exact 0.150.1 permission-only config/read subset, not general Codex configuration.
 * Evidence: tests/fixtures/codex-native-config-0.150.1/provenance.json.
 * ConfigToml serializes absent Option fields as null. No non-null override is admitted.
 */
const NULL_CONFIG_FIELDS = Object.freeze([
  "agents", "analytics", "approval_policy",
  "approvals_reviewer", "apps", "apps_mcp_product_sku",
  "audio", "auto_review", "browser_use",
  "check_for_update_on_startup", "compact_prompt", "computer_use",
  "desktop", "developer_instructions", "disable_paste_burst",
  "experimental_compact_prompt_file", "experimental_realtime_start_instructions", "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_backend_prompt", "experimental_realtime_ws_base_url", "experimental_realtime_ws_model",
  "experimental_realtime_ws_startup_context", "experimental_thread_store", "experimental_thread_store_endpoint",
  "experimental_use_unified_exec_tool", "feedback", "forced_chatgpt_workspace_id",
  "forced_login_method", "ghost_snapshot", "goals",
  "hooks", "instructions", "js_repl_node_module_dirs",
  "js_repl_node_path", "log_dir", "mcp_oauth_callback_port",
  "mcp_oauth_callback_url", "memories", "model",
  "model_auto_compact_token_limit", "model_auto_compact_token_limit_scope", "model_catalog_json",
  "model_context_window", "model_instructions_file", "model_provider",
  "model_reasoning_effort", "model_reasoning_summary", "model_verbosity",
  "notice", "notify", "openai_base_url",
  "orchestrator", "oss_provider", "otel",
  "personality", "plan_mode_reasoning_effort", "profile",
  "projects", "realtime", "responses_api_metadata",
  "review_model", "sandbox_mode", "sandbox_workspace_write",
  "service_tier", "show_raw_agent_reasoning", "skills",
  "sqlite_home", "suppress_unstable_features_warning", "tool_output_token_limit",
  "tool_suggest", "tools", "tui",
  "web_search", "windows",
] as const);

export const DISABLED_CODEX_FEATURES = Object.freeze([
  "apps", "browser_use", "computer_use", "image_generation",
  "multi_agent", "multi_agent_v2", "plugins", "remote_plugin",
] as const);

export const codexDisabledFeatures = (): Record<string, false> =>
  Object.fromEntries(DISABLED_CODEX_FEATURES.map(key => [key, false]));

/** Fresh values so neither callers nor validation can mutate shared nested defaults. */
export const codexNativeConfigDefaults = (): Record<string, unknown> => ({
  ...Object.fromEntries(NULL_CONFIG_FIELDS.map(key => [key, null])),
  // Packaged config/defaults.toml; ConfigManager::read hides that layer and its origins.
  include_permissions_instructions: true,
  include_apps_instructions: true,
  include_collaboration_mode_instructions: true,
  include_environment_context: true,
  cli_auth_credentials_store: "file",
  mcp_oauth_credentials_store: "auto",
  project_doc_max_bytes: 32768,
  project_doc_fallback_filenames: [],
  background_terminal_max_timeout: 300000,
  file_opener: "vscode",
  hide_agent_reasoning: false,
  chatgpt_base_url: "https://chatgpt.com/backend-api/",
  project_root_markers: [".git"],
  history: { persistence: "save-all", max_bytes: null },
  // ConfigManager::read inserts this default; it is not a launch override.
  allow_login_shell: true,
  // Empty serde-default maps and ShellEnvironmentPolicyToml Options.
  model_providers: {}, profiles: {}, mcp_servers: {}, plugins: {}, marketplaces: {},
  shell_environment_policy: {
    inherit: null, ignore_default_excludes: null, exclude: null, set: null,
    include_only: null, filters: null, experimental_use_profile: null,
  },
  features: {
    ...codexDisabledFeatures(),
    network_proxy: null, // FeaturesToml's absent structured field.
    // ConfigRequestProcessor::read materializes these pinned Features defaults.
    auth_elicitation: true, mcp_2026_07_28: false, memories: false,
    mentions_v2: true, remote_control: false, tool_suggest: true,
  },
});
