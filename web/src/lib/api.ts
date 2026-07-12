import { httpRequest, request } from "@/lib/request";

/** 把参数对象拼成 query string，跳过 undefined/null/空串。 */
function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}

export type PageParams = {
  page?: number;
  page_size?: number;
};


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
  last_refresh_error?: string | null;
  last_token_refresh_error?: string | null;
  success: number;
  fail: number;
  image_inflight?: number;
  last_used_at?: string | null;
  proxy?: string | null;
  country?: string | null;
  exit_ip?: string | null;
  password?: string | null;
  created_at?: string | null;
  last_token_refresh_at?: string | null;
  mail_link?: string | null;
  // 2FA (TOTP) 相关字段
  totp_secret?: string | null;
  otpauth_url?: string | null;
  // 导出消费标记
  used?: boolean;
  checkout_at?: string | null;
  checkout_meta?: {
    customer?: string;
    wechat?: string;
    xianyu?: string;
    plan?: string;
    note?: string;
    dispatch_no?: string;
    phone?: string;
    checkout_at?: string;
  } | null;
  // Plus 激活相关字段
  plus_status?: PlusStatus;
  plus_attempts?: { UPI: number; IDEL: number };
  plus_cdk?: string | null;
  // 激活成功/最近一次尝试所用的 CDK 类型（UPI/IDEL），用于号池列表的类型标识与 CDK↔账号绑定溯源。
  plus_cdk_type?: CdkType | null;
  plus_task_id?: string | null;
  // 激活进度与失败原因（批量激活页「激活失败清单」/「需核查」展示）。
  plus_last_message?: string | null;
  plus_updated_at?: string | null;
  last_activation_audit_id?: string | null;
  // 激活不可用标记：两种类型 CDK 均连续激活失败后置位，下轮激活自动跳过，直到人工标记可用。
  plus_unavailable?: boolean;
  // 首次激活成功（plus_status→已激活）时间，用于账号管理「激活日期」列。
  plus_activated_at?: string | null;
  activated_at?: string | null;
  stage?: AccountStage;
  stage_label?: string;
  plan?: "free" | "plus";
  token_status?: "ok" | "rate_limited" | "invalid";
  // 注册失败与 Token 刷新失败（账号页「错误信息」）；不含激活失败详情。
  last_error?: string | null;
  fetch_url?: string | null;
  dispatch?: DispatchInfo | null;
  fingerprint_seed?: string | number | null;
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
  summary: AccountSummary;
  total: number;
  page: number;
  page_size: number;
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  relogined?: number;
  refresh_progress_id?: string;
  errors?: Array<{ access_token: string; error: string }>;
};

export type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
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
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
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
  cooldown?: number;
};

type MailboxListPayload = {
  items: Mailbox[];
  stats: MailboxStats;
};

type MailboxListResponse = MailboxListPayload & {
  total: number;
  page: number;
  page_size: number;
};

// ── CDKs（Plus CDK 管理）───────────────────────────────────────────

export type CdkType = "UPI" | "IDEL";
export type CdkStatus = "available" | "used" | "invalid";

export type CdkBoundAccount = {
  email?: string | null;
  password?: string | null;
  totp_secret?: string | null;
  otpauth_url?: string | null;
  fetch_url?: string | null;
  status?: string | null;
  plus_status?: string | null;
  source_type?: string | null;
  created_at?: string | null;
};

export type Cdk = {
  cdk: string;
  type: CdkType;
  status: CdkStatus;
  bound_token: string | null;
  bound_account?: CdkBoundAccount | null;
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

type CdkListPayload = {
  items: Cdk[];
  counts: CdkCounts;
};

type CdkListResponse = CdkListPayload & {
  total: number;
  page: number;
  page_size: number;
};

// ── Phones（手机号池管理）──────────────────────────────────────────

/** 单个手机号最多出库次数（满则自动标记已使用），与后端 MAX_USES 对齐。 */
export const PHONE_MAX_USES = 3;

export type Phone = {
  phone: string;
  fetch_url: string;
  used: boolean;
  used_count: number;
  invalid: boolean;
  cooldown_until: string | null;
  reserved_at?: string | null;
  last_used_at: string | null;
  imported_at: string | null;
  note: string;
  checkout_at?: string | null;
  checkout_meta?: {
    customer?: string;
    wechat?: string;
    xianyu?: string;
    plan?: string;
    note?: string;
    dispatch_no?: string;
    account_token?: string;
    checkout_at?: string;
  } | null;
  checkout_records?: Array<{
    customer?: string;
    wechat?: string;
    xianyu?: string;
    plan?: string;
    note?: string;
    dispatch_no?: string;
    account_token?: string;
    checkout_at?: string;
  }>;
};

export type PhoneCounts = {
  total: number;
  available: number;
  cooldown: number;
  used: number;
  invalid: number;
  total_uses: number;
};

type PhoneListPayload = {
  items: Phone[];
  counts: PhoneCounts;
};

type PhoneListResponse = PhoneListPayload & {
  total: number;
  page: number;
  page_size: number;
};

// ── Activation（Plus 激活）─────────────────────────────────────────

export type ActivationStats = {
  total: number;
  done: number;
  success: number;
  fail: number;
  /** 因账号已在激活中或不满足条件而跳过的次数（不计入失败） */
  skipped?: number;
  /** 本轮转人工核查的账号数 */
  review?: number;
  /** 当前被占用、正在激活流程中的账号数（内存态） */
  claiming?: number;
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
  // 按真实套餐 type 判定：plus_by_type=已是 Plus；not_plus_by_type=非 Plus 账号总数。
  plus_by_type?: number;
  not_plus_by_type?: number;
  // pending=可被激活引擎选中的账号数（与 start 时 _resolve_targets 口径一致）。
  pending?: number;
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
  // 服务端 timeout：同卡重入列重试上限（不计失败次数），超限转人工核查
  timeout_retry_max: number;
  // 服务端 failed：同卡重试上限，用尽才换下一张卡
  failed_retry_max: number;
  api_key: string;
  has_api_key: boolean;
  auto_activate_after_register: boolean;
  // 激活数量（本轮目标激活数）；启动激活时作为 limit 缺省值。0 表示不限量。
  target: number;
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
  proxy_mode?: "none" | "ipweb" | "http";
  http_proxy?: string;
  /** 前端 UI：由 proxy 解析或用户填写，保存时组装回 proxy */
  ipweb_gateway?: string;
  ipweb_account_id?: string;
  ipweb_password?: string;
  total: number;
  threads: number;
  enable_2fa?: boolean;
  auto_set_password?: boolean;
  regions?: string[];
  ipweb_rotate?: boolean;
  ip_duration?: number;
  register_timeout?: number;
  static_cache_enabled?: boolean;
  static_cache_max_age_days?: number;
  static_cache_dir?: string;
  static_cache_size_bytes?: number;
  static_cache_file_count?: number;
  static_cache_resolved_dir?: string;
  record_enabled?: boolean;
  record_dir?: string;
  record_keep?: "fail" | "all" | "none";
  record_dir_count?: number;
  record_size_bytes?: number;
  record_resolved_dir?: string;
  diag_public_url?: string;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    active_browsers?: number;
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
  // 正在注册的每个任务的实时进度（按任务号）：供工作台「正在注册账号」表展示。
  progress?: RegisterProgressItem[];
};

export type RegisterProgressItem = {
  index: number;
  email: string;
  step: string;
  level: string;
  status: "running" | "success" | "fail";
  updated_at?: string;
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

export type AccountStage =
  | "unregistered"
  | "registering"
  | "registered"
  | "activating"
  | "plus_activated";

export type AccountView = "free" | "plus";

export type DispatchInfo = {
  dispatched?: boolean;
  dispatched_at?: string | null;
  customer?: string;
  wechat?: string;
  xianyu?: string;
  plan?: string;
  note?: string;
  dispatch_no?: string;
};

export type AccountListParams = PageParams & {
  q?: string;
  view?: AccountView;
  stage?: AccountStage;
  plan?: "free" | "plus";
  status?: "alive" | "dead";
  avail?: "available" | "unavailable";
  activation?: "pending" | "activated" | "activating" | "failed" | "review";
  used?: boolean;
  dispatched?: boolean;
};

export type AccountSummary = {
  total: number;
  undispatched?: number;
  unregistered?: number;
  registering?: number;
  registered?: number;
  activating?: number;
  plus_activated?: number;
  // legacy fields for older callers
  alive?: number;
  dead?: number;
  activated?: number;
  pending?: number;
  unused?: number;
};

export async function fetchAccounts(params: AccountListParams = {}) {
  return httpRequest<AccountListResponse>(`/api/accounts${buildQuery(params)}`);
}

export async function createAccounts(tokens: string[], accounts: AccountImportPayload[] = [], text = "") {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens, accounts, text },
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

// 导出账号凭据文本：每行 `邮箱----接码----密码----2FA密钥`。传空数组导出全部。
export async function exportCredentials(
  accessTokens: string[],
  opts: { onlyUnused?: boolean; markUsed?: boolean } = {},
) {
  const response = await request.request<string>({
    url: "/api/accounts/export-credentials",
    method: "POST",
    data: { access_tokens: accessTokens, only_unused: !!opts.onlyUnused, mark_used: !!opts.markUsed },
    responseType: "text",
  });
  return response.data;
}

// 账号管理导出：每行 `邮箱---密码---2FA--Accesstoken`（与导入格式一致，可回环）。传空数组导出全部。
export async function exportAccountPool(
  accessTokens: string[],
  opts: {
    onlyUnused?: boolean;
    markUsed?: boolean;
    view?: AccountView;
    stage?: AccountStage;
    onlyUndispatched?: boolean;
    markDispatched?: boolean;
  } = {},
) {
  const response = await request.request<string>({
    url: "/api/accounts/export-pool",
    method: "POST",
    data: {
      access_tokens: accessTokens,
      only_unused: !!opts.onlyUnused,
      mark_used: !!(opts.markUsed || opts.markDispatched),
      view: opts.view,
      stage: opts.stage,
      only_undispatched: opts.onlyUndispatched !== false,
      mark_dispatched: !!opts.markDispatched,
    },
    responseType: "text",
  });
  return response.data;
}

// 账号导出：完整 JSON（含 access/refresh/id token + proxy/country/exit_ip + 密码/2FA）。
export async function exportAccounts(
  accessTokens: string[],
  format: "json" | "zip" = "json",
) {
  const response = await request.request<string>({
    url: "/api/accounts/export",
    method: "POST",
    data: { access_tokens: accessTokens, format },
    responseType: "text",
  });
  return response.data;
}

export async function markAccountsUsed(
  accessTokens: string[],
  used: boolean,
  metaByToken: Record<string, { customer?: string; wechat?: string; xianyu?: string; plan?: string; note?: string }> = {},
) {
  return httpRequest<{ updated: number; items: Account[] }>("/api/accounts/mark-used", {
    method: "POST",
    body: { access_tokens: accessTokens, used, meta_by_token: metaByToken },
  });
}

// 撤销激活：将 plus_review 账号复位为免费可激活态，可选同步撤销 CDK 使用。
export async function revokeActivation(accessTokens: string[], revokeCdk = true) {
  return httpRequest<{ updated: number; cdk_revoked: number; skipped: number; items: Account[] }>(
    "/api/accounts/revoke-activation",
    {
      method: "POST",
      body: { access_tokens: accessTokens, revoke_cdk: revokeCdk },
    },
  );
}

// ── Mailboxes ──────────────────────────────────────────────────────
export type MailboxListParams = PageParams & {
  q?: string;
  status?: "unused" | "used" | "in_use";
};

export async function fetchMailboxes(params: MailboxListParams = {}) {
  return httpRequest<MailboxListResponse>(`/api/mailboxes${buildQuery(params)}`);
}

export async function importMailboxes(text: string) {
  return httpRequest<MailboxListPayload & { result: { added: number; updated: number; skipped: number; total: number } }>(
    "/api/mailboxes",
    {
      method: "POST",
      body: { text },
    },
  );
}

export async function deleteMailboxes(emails: string[]) {
  return httpRequest<MailboxListPayload & { removed: number }>("/api/mailboxes", {
    method: "DELETE",
    body: { emails },
  });
}

export async function markMailboxes(emails: string[], used: boolean) {
  return httpRequest<MailboxListPayload & { changed: number }>("/api/mailboxes/mark", {
    method: "POST",
    body: { emails, used },
  });
}

/** 拉取导出文本（`邮箱---收件地址`）。only_unused=true 仅导出待注册。 */
export async function fetchMailboxesExportText(onlyUnused = false): Promise<string> {
  const params = new URLSearchParams();
  if (onlyUnused) params.set("only_unused", "true");
  const path = `/api/mailboxes/export${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await request.get<string>(path, { responseType: "text" });
  return String(response.data ?? "");
}

// ── CDKs ───────────────────────────────────────────────────────────

export type CdkListParams = PageParams & {
  q?: string;
  status?: CdkStatus;
  type?: CdkType;
};

export async function fetchCdks(params: CdkListParams = {}) {
  return httpRequest<CdkListResponse>(`/api/cdks${buildQuery(params)}`);
}

export async function importCdks(text: string, type: CdkType) {
  return httpRequest<CdkListPayload & { result: { added: number; updated: number; skipped: number; total: number } }>("/api/cdks", {
    method: "POST",
    body: { text, type },
  });
}

export async function deleteCdks(cdks: string[]) {
  return httpRequest<CdkListPayload & { removed: number }>("/api/cdks", {
    method: "DELETE",
    body: { cdks },
  });
}

// 危险操作：批量撤销 CDK 使用（used/invalid → available，清除账号绑定），仅供程序误标时人工纠正。
export async function revokeCdkUse(cdks: string[]) {
  return httpRequest<CdkListPayload & { revoked: number }>("/api/cdks/revoke", {
    method: "POST",
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

// ── Phones ─────────────────────────────────────────────────────────

export type PhoneListParams = PageParams & {
  q?: string;
  used?: "0" | "1";
};

export async function fetchPhones(params: PhoneListParams = {}) {
  return httpRequest<PhoneListResponse>(`/api/phones${buildQuery(params)}`);
}

export async function importPhones(text: string) {
  return httpRequest<PhoneListPayload & { result: { added: number; updated: number; total: number } }>("/api/phones", {
    method: "POST",
    body: { text },
  });
}

export async function deletePhones(phones: string[]) {
  return httpRequest<PhoneListPayload & { removed: number }>("/api/phones", {
    method: "DELETE",
    body: { phones },
  });
}

export async function setPhonesUsed(phones: string[], used: boolean) {
  return httpRequest<PhoneListPayload & { changed: number }>("/api/phones/used", {
    method: "PATCH",
    body: { phones, used },
  });
}

/** 累计使用次数 +delta（默认 +1），后端自动标记为已使用。 */
export async function addPhoneUsage(
  phones: string[],
  delta = 1,
  metaByPhone: Record<string, { customer?: string; wechat?: string; xianyu?: string; plan?: string; note?: string; dispatch_no?: string; account_token?: string }> = {},
) {
  return httpRequest<PhoneListPayload & { changed: number }>("/api/phones/use", {
    method: "POST",
    body: { phones, delta, meta_by_phone: metaByPhone },
  });
}

/** 拉取导出文本（`手机号----接码地址`）。only_unused=true 仅导出未使用。 */
export async function fetchPhonesExportText(onlyUnused = false): Promise<string> {
  const params = new URLSearchParams();
  if (onlyUnused) params.set("only_unused", "true");
  const path = `/api/phones/export${params.toString() ? `?${params.toString()}` : ""}`;
  const response = await request.get<string>(path, { responseType: "text" });
  return String(response.data ?? "");
}

// ── Dispatch（发号管理）────────────────────────────────────────────

export type DispatchKind = "phone" | "account";
export type DispatchAction = "checkout" | "cooldown" | "invalid" | "release";

export type DispatchField = { label: string; value: string; copyable?: boolean };

export type DispatchItem = {
  kind: DispatchKind;
  id: string;
  title: string;
  fields: DispatchField[];
  used_count?: number;
  max_uses?: number;
};

export type DispatchSummary = {
  account_available: number;
  phone_available: number;
};

export async function fetchDispatchSummary() {
  return httpRequest<DispatchSummary>("/api/dispatch/summary");
}

export async function fetchDispatchAccounts() {
  return httpRequest<{
    items: Array<{ email: string | null; access_token: string; activated_at?: string | null; country?: string | null; exit_ip?: string | null }>;
    summary: DispatchSummary;
  }>("/api/dispatch/accounts");
}

/** 发号：预占并返回可用号。releaseId 用于「下一个」先释放当前预占；token 指定 Plus 账号。 */
export async function acquireDispatch(kind: DispatchKind, releaseId?: string, token?: string) {
  return httpRequest<{ item: DispatchItem | null; summary: DispatchSummary }>("/api/dispatch/acquire", {
    method: "POST",
    body: { kind, release_id: releaseId, token },
  });
}

/** 对已预占的号执行动作：出库 / 冷却 / 无效 / 释放。 */
export async function dispatchAction(kind: DispatchKind, id: string, action: DispatchAction) {
  return httpRequest<{ ok: boolean; message?: string; summary: DispatchSummary }>("/api/dispatch/action", {
    method: "POST",
    body: { kind, id, action },
  });
}

export async function dispatchCheckout(
  kind: DispatchKind,
  id: string,
  payload: {
    customer?: string;
    wechat?: string;
    xianyu?: string;
    plan?: string;
    note?: string;
    dispatchNo?: string;
    relatedPhone?: string;
    relatedAccountToken?: string;
    pairCheckout?: boolean;
  },
) {
  return httpRequest<{ ok: boolean; message?: string; summary: DispatchSummary }>("/api/dispatch/action", {
    method: "POST",
    body: {
      kind,
      id,
      action: "checkout",
      customer: payload.customer,
      wechat: payload.wechat,
      xianyu: payload.xianyu,
      plan: payload.plan,
      note: payload.note,
      dispatch_no: payload.dispatchNo,
      related_phone: payload.relatedPhone,
      related_account_token: payload.relatedAccountToken,
      pair_checkout: payload.pairCheckout,
    },
  });
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
  timeout_retry_max: number;
  failed_retry_max: number;
  auto_activate_after_register: boolean;
  target: number;
}>) {
  return httpRequest<{ config: ActivationConfig }>("/api/activation/config", {
    method: "POST",
    body: updates,
  });
}

export async function startActivation(
  tokens?: string[],
  limit?: number,
  emails?: string[],
  concurrency?: number,
) {
  const body: Record<string, unknown> = {};
  if (tokens && tokens.length > 0) body.tokens = tokens;
  if (emails && emails.length > 0) body.emails = emails;
  if (limit && limit > 0) body.limit = limit;
  if (concurrency && concurrency > 0) body.concurrency = concurrency;
  return httpRequest<ActivationState>("/api/activation/start", {
    method: "POST",
    body,
  });
}

export async function stopActivation() {
  return httpRequest<ActivationState>("/api/activation/stop", { method: "POST" });
}

export async function clearActivationLogs() {
  return httpRequest<ActivationState>("/api/activation/clear-logs", { method: "POST" });
}

export type ActivationAuditEvent = {
  time: string;
  kind: "log" | "http" | "plan_verify";
  text?: string;
  level?: string;
  phase?: string;
  attempt?: number;
  retrying?: boolean;
  method?: string;
  path?: string;
  url?: string;
  http_status?: number | null;
  request?: unknown;
  response?: unknown;
  error?: string | null;
  tier?: string;
};

export type ActivationAuditSummary = {
  id: string;
  email: string;
  access_token: string;
  job_id?: string | null;
  source?: string;
  outcome: string;
  summary: string;
  cdk?: string | null;
  cdk_type?: string | null;
  cdk_consumed?: boolean;
  started_at: string;
  finished_at?: string | null;
  event_count?: number;
  attempt_count?: number;
};

export type ActivationAuditRecord = ActivationAuditSummary & {
  events: ActivationAuditEvent[];
};

export type ActivationAuditListParams = PageParams & {
  q?: string;
  outcome?: string;
  abnormal_only?: boolean;
};

export async function fetchActivationAudit(params: ActivationAuditListParams = {}) {
  return httpRequest<{
    items: ActivationAuditSummary[];
    total: number;
    page: number;
    page_size: number;
    stats: { total: number; accounts: number; failed: number; review: number; success: number };
  }>(`/api/activation/audit${buildQuery(params)}`);
}

export async function fetchActivationAuditDetail(auditId: string) {
  return httpRequest<{ item: ActivationAuditRecord }>(`/api/activation/audit/${encodeURIComponent(auditId)}`);
}

export async function fetchLatestActivationAudit(params: { access_token?: string; email?: string }) {
  const q = new URLSearchParams();
  if (params.access_token) q.set("access_token", params.access_token);
  if (params.email) q.set("email", params.email);
  return httpRequest<{ item: ActivationAuditRecord }>(`/api/activation/audit/by-account/latest?${q.toString()}`);
}

export async function deleteActivationAudit(params: {
  emails?: string[];
  access_tokens?: string[];
  delete_accounts?: boolean;
}) {
  return httpRequest<{ removed: number; accounts_removed: number }>("/api/activation/audit", {
    method: "DELETE",
    body: params,
  });
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

export async function startRegister(emails?: string[]) {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", {
    method: "POST",
    body: emails && emails.length ? { emails } : {},
  });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

export async function clearRegisterLogs() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/clear-logs", { method: "POST" });
}

export async function clearRegisterRecordings() {
  return httpRequest<{
    register: RegisterConfig;
    dirs_removed: number;
    bytes_freed: number;
  }>("/api/register/clear-recordings", { method: "POST" });
}

// ── Register abnormal accounts（注册机异常账号清单）──────────────────

export type RegisterAbnormal = {
  email: string;
  fetch_url: string;
  reason: string;
  access_token: string | null;
  password: string | null;
  eligible: boolean | null;
  recording_path?: string | null;
  created_at: string;
  urls?: {
    brief?: string;
    artifacts?: string;
    recording?: string;
    screenshot?: string;
    trace?: string;
  };
};

export type RegisterAbnormalStats = {
  total: number;
  no_trial: number;
  other: number;
};

export type RegisterAbnormalListParams = PageParams & { q?: string };

export async function fetchRegisterAbnormal(params: RegisterAbnormalListParams = {}) {
  return httpRequest<{
    items: RegisterAbnormal[];
    stats: RegisterAbnormalStats;
    total: number;
    page: number;
    page_size: number;
  }>(`/api/register/abnormal${buildQuery(params)}`);
}

export async function deleteRegisterAbnormal(emails: string[]) {
  return httpRequest<{
    items: RegisterAbnormal[];
    stats: RegisterAbnormalStats;
    removed: number;
    logs_removed?: number;
    recordings_removed?: number;
    bytes_freed?: number;
  }>(
    "/api/register/abnormal",
    { method: "DELETE", body: { emails } },
  );
}

// 导出异常清单文本（`邮箱---取件地址---原因`）。
export async function fetchRegisterAbnormalExportText(): Promise<string> {
  const response = await request.get<string>("/api/register/abnormal/export", { responseType: "text" });
  return String(response.data ?? "");
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

// ── One-click Run（一键运行编排）─────────────────────────────────────
export type RunStats = {
  target: number;
  registered: number;
  activated: number;
  failed: number;
  running: number;
  phase: string;
  job_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at?: string | null;
};

export type RunLog = { time: string; text: string; level: string };

export type RunState = {
  running: boolean;
  stats: RunStats;
  summary: { free: number; activated: number; activating: number; total: number };
  cdk: CdkCounts;
  mailbox_available: number;
  logs: RunLog[];
};

export async function fetchRun() {
  return httpRequest<RunState>("/api/run");
}

export async function startRun(target: number, autoReplenish: boolean) {
  return httpRequest<RunState>("/api/run/start", {
    method: "POST",
    body: { target, auto_replenish: autoReplenish },
  });
}

export async function stopRun() {
  return httpRequest<RunState>("/api/run/stop", { method: "POST" });
}
