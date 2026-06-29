import { httpRequest, request } from "@/lib/request";

export type AccountType = string;
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type AuthRole = "admin" | "user";

export type PlusStatus = "未激活" | "排队中" | "激活中" | "已激活" | "激活失败";

export type Account = {
  access_token: string;
  type: AccountType;
  source_type?: string | null;
  status: AccountStatus;
  quota: number;
  image_quota_unknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restore_at?: string | null;
  success: number;
  fail: number;
  image_inflight?: number;
  last_used_at?: string | null;
  proxy?: string | null;
  // Plus 激活相关字段
  plus_status?: PlusStatus;
  plus_attempts?: { UPI: number; IDEL: number };
  plus_cdk?: string | null;
  plus_task_id?: string | null;
  plus_last_message?: string | null;
  plus_updated_at?: string | null;
};

export type AccountImportPayload = {
  access_token: string;
  accessToken?: string;
  type?: string;
  export_type?: string;
  source_type?: string;
  [key: string]: unknown;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  relogined?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

export type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  relogined?: number;
  errors: Array<{ access_token: string; error: string }>;
};

export type RefreshProgressResponse = {
  total: number;
  processed: number;
  done: boolean;
  error: string | null;
  status_counts?: Record<string, number>;
  total_quota?: number;
  result?: AccountRefreshResponse | null;
  results?: Array<{ token: string; status: string; error?: string | null }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  global_system_prompt?: string;
  sensitive_words?: string[];
  refresh_account_interval_minute?: number | string;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  auto_relogin_after_refresh?: boolean;
  log_levels?: string[];
  [key: string]: unknown;
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
};

export type UserKey = {
  id: string;
  name: string;
  role: "user";
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
};

// ── Mailboxes（邮箱管理）─────────────────────────────────────────────

export type Mailbox = {
  email: string;
  fetch_url: string;
  used: boolean;
  in_use: boolean;
  account_token: string | null;
  registered_at: string | null;
  imported_at: string | null;
  note: string;
};

export type MailboxStats = {
  total: number;
  used: number;
  unused: number;
  in_use: number;
};

type MailboxListResponse = {
  items: Mailbox[];
  stats: MailboxStats;
};

// ── CDKs（Plus CDK 管理）───────────────────────────────────────────

export type CdkType = "UPI" | "IDEL";
export type CdkStatus = "available" | "used" | "invalid";

export type Cdk = {
  cdk: string;
  type: CdkType;
  status: CdkStatus;
  bound_token: string | null;
  used_at: string | null;
  imported_at: string | null;
  note: string;
};

export type CdkTypeCounts = {
  available: number;
  used: number;
  invalid: number;
};

export type CdkCounts = {
  by_type: {
    UPI: CdkTypeCounts;
    IDEL: CdkTypeCounts;
  };
  available: number;
  total: number;
};

type CdkListResponse = {
  items: Cdk[];
  counts: CdkCounts;
};

// ── Activation（Plus 激活）─────────────────────────────────────────

export type ActivationStats = {
  total: number;
  done: number;
  success: number;
  fail: number;
  running: number;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at?: string | null;
  job_id?: string;
};

export type ActivationSummary = {
  free: number;
  activated: number;
  activating: number;
  total: number;
};

export type ActivationLog = {
  time: string;
  text: string;
  level: string;
};

export type ActivationConfig = {
  base_url: string;
  concurrency: number;
  poll_interval: number;
  poll_timeout: number;
  max_attempts_per_type: number;
  api_key: string;
  has_api_key: boolean;
};

export type ActivationState = {
  activation: {
    running: boolean;
    stats: ActivationStats;
    summary: ActivationSummary;
    logs: ActivationLog[];
  };
  config: ActivationConfig;
};

// ── Register（注册机）──────────────────────────────────────────────

export type RegisterProviderType = "api_mailbox" | "cloudmail_gen";

export type RegisterProvider = {
  type: RegisterProviderType;
  enable: boolean;
  label?: string;
  // cloudmail_gen only
  api_base?: string;
  admin_email?: string;
  admin_password?: string;
  domain?: string[];
  subdomain?: string[];
  email_prefix?: string;
  [key: string]: unknown;
};

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    providers: RegisterProvider[];
  };
  proxy: string;
  total: number;
  threads: number;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    elapsed_seconds?: number;
    avg_seconds?: number;
    success_rate?: number;
    current_available?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
  };
  logs?: Array<{
    time: string;
    text: string;
    level: string;
  }>;
};

// ── Auth ───────────────────────────────────────────────────────────

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

// ── Accounts ───────────────────────────────────────────────────────

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function createAccounts(tokens: string[], accounts: AccountImportPayload[] = []) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens, accounts },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<{ progress_id: string }>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function fetchRefreshProgress(progressId: string) {
  return httpRequest<RefreshProgressResponse>(`/api/accounts/refresh/progress/${progressId}`);
}

export async function reLoginAccounts(accessTokens: string[]) {
  return httpRequest<{ progress_id: string }>("/api/accounts/re-login", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function fetchReLoginProgress(progressId: string) {
  return httpRequest<RefreshProgressResponse>(`/api/accounts/re-login/progress/${progressId}`);
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
    proxy?: string;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

// ── Mailboxes ──────────────────────────────────────────────────────

export async function fetchMailboxes() {
  return httpRequest<MailboxListResponse>("/api/mailboxes");
}

export async function importMailboxes(text: string) {
  return httpRequest<MailboxListResponse & { result: { added: number; updated: number; total: number } }>(
    "/api/mailboxes",
    {
      method: "POST",
      body: { text },
    },
  );
}

export async function deleteMailboxes(emails: string[]) {
  return httpRequest<MailboxListResponse & { removed: number }>("/api/mailboxes", {
    method: "DELETE",
    body: { emails },
  });
}

export async function markMailboxes(emails: string[], used: boolean) {
  return httpRequest<MailboxListResponse & { changed: number }>("/api/mailboxes/mark", {
    method: "POST",
    body: { emails, used },
  });
}

// ── CDKs ───────────────────────────────────────────────────────────

export async function fetchCdks() {
  return httpRequest<CdkListResponse>("/api/cdks");
}

export async function importCdks(text: string, type: CdkType) {
  return httpRequest<CdkListResponse & { result: { added: number; updated: number; total: number } }>("/api/cdks", {
    method: "POST",
    body: { text, type },
  });
}

export async function deleteCdks(cdks: string[]) {
  return httpRequest<CdkListResponse & { removed: number }>("/api/cdks", {
    method: "DELETE",
    body: { cdks },
  });
}

export async function exportCdks(type?: CdkType) {
  const params = new URLSearchParams();
  if (type) {
    params.set("type", type);
  }
  const path = `/api/cdks/export${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await request.get<string>(path, { responseType: "text" });
  const blob = new Blob([String(response.data ?? "")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cdks-${type ?? "all"}-${Date.now()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Activation ─────────────────────────────────────────────────────

export async function fetchActivation() {
  return httpRequest<ActivationState>("/api/activation");
}

export async function updateActivationConfig(updates: Partial<{
  base_url: string;
  api_key: string;
  concurrency: number;
  poll_interval: number;
  poll_timeout: number;
  max_attempts_per_type: number;
}>) {
  return httpRequest<{ config: ActivationConfig }>("/api/activation/config", {
    method: "POST",
    body: updates,
  });
}

export async function startActivation(tokens?: string[]) {
  return httpRequest<ActivationState>("/api/activation/start", {
    method: "POST",
    body: tokens && tokens.length > 0 ? { tokens } : {},
  });
}

export async function stopActivation() {
  return httpRequest<ActivationState>("/api/activation/stop", { method: "POST" });
}

// ── Settings ───────────────────────────────────────────────────────

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

// ── User keys ──────────────────────────────────────────────────────

export async function fetchUserKeys() {
  return httpRequest<{ items: UserKey[] }>("/api/auth/users");
}

export async function createUserKey(name: string) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/auth/users", {
    method: "POST",
    body: { name },
  });
}

export async function updateUserKey(keyId: string, updates: { enabled?: boolean; name?: string; key?: string }) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUserKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "DELETE",
  });
}

// ── Register ───────────────────────────────────────────────────────

export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register");
}

export async function updateRegisterConfig(updates: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: updates,
  });
}

export async function startRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", { method: "POST" });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

// ── Upstream proxy ─────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
