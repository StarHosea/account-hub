import { useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  Card,
  Button,
  Tag,
  Toast,
  Modal,
  SideSheet,
  Select,
  Input,
  Spin,
  Typography,
  Dropdown,
  Popconfirm,
  Space,
  TextArea,
  Tooltip,
  Checkbox,
  Pagination,
} from "@douyinfe/semi-ui-19";
import {
  IconRefresh,
  IconSync,
  IconDownload,
  IconUpload,
  IconShield,
  IconDelete,
  IconMail,
  IconKey,
  IconCopy,
  IconSearch,
  IconInfoCircle,
} from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  fetchAccounts,
  refreshAccounts,
  fetchRefreshProgress,
  refreshAccountPlans,
  fetchRefreshPlanProgress,
  refreshAccountTokens,
  fetchRefreshTokenProgress,
  fetchAccountDetail,
  deleteAccounts,
  createAccounts,
  exportAccounts,
  markAccountsUsed,
  type Account,
  type AccountDetail,
  type AccountImportPayload,
  type AccountSummary,
  type AccountListParams,
  type AccountStage,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useIsMobile } from "@/lib/use-is-mobile";
import { copyToClipboard as copy } from "@/lib/clipboard";
import { importSubmitGuard, isAccountPoolImportText, validateAccountImport } from "@/lib/import-validation";
import { StatCards } from "@/components/StatCards";
import { MobileFilters } from "@/components/MobileFilters";
import ImportCountHint from "@/components/ImportCountHint";
import { navRef } from "@/constants/nav";
const { Text } = Typography;

const PAGE_SIZE = 10;
const EMPTY_SUMMARY: AccountSummary = { total: 0 };

const STAGE_TAG_COLOR: Record<string, string> = {
  unregistered: "grey",
  registering: "blue",
  registered: "cyan",
  activating: "orange",
  plus_activated: "green",
};

function stageTag(a: Account, isRefreshing: boolean) {
  if (isRefreshing) {
    return (
      <Space spacing={4}>
        <Spin size="small" />
        <Tag color="blue" type="light">校验中</Tag>
      </Space>
    );
  }
  const stage = a.stage || "registered";
  const label = a.stage_label || stage;
  return <Tag color={(STAGE_TAG_COLOR[stage] ?? "grey") as never} type="light">{label}</Tag>;
}

/** 对齐 sub2api planTypeDisplayLabel：canonical 值映射为友好标签。 */
function planTypeDisplayLabel(value: string): string {
  switch (value.trim().toLowerCase().replace(/[\s_-]+/g, "")) {
    case "plus":
      return "Plus";
    case "pro":
    case "chatgptpro":
      return "Pro";
    case "free":
    case "basic":
      return "Free";
    case "team":
      return "Team";
    default:
      return value.trim();
  }
}

function planTypeTag(tier: string | undefined | null, isSyncing = false) {
  if (isSyncing) {
    return (
      <Space spacing={4}>
        <Spin size="small" />
        <Text type="tertiary" size="small">同步中</Text>
      </Space>
    );
  }
  const raw = (tier || "").trim();
  if (!raw) return <Text type="tertiary">—</Text>;
  const label = planTypeDisplayLabel(raw);
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  const color =
    key === "plus" ? "green"
    : key === "pro" || key === "chatgptpro" ? "purple"
    : key === "free" || key === "basic" ? "grey"
    : "blue";
  return <Tag color={color as never} type="light">{label}</Tag>;
}

const PLUS_STATUS_TAG_COLOR: Record<string, string> = {
  未激活: "grey",
  排队中: "blue",
  激活中: "orange",
  已激活: "green",
  激活失败: "red",
};

function activationStatusTag(a: Account) {
  const st = a.plus_status ?? (a.is_activated ? "已激活" : "未激活");
  return <Tag color={(PLUS_STATUS_TAG_COLOR[st] ?? "grey") as never} type="light">{st}</Tag>;
}

function renderGeo(a: Account) {
  const ip = a.exit_ip || "—";
  const country = a.country ? <Tag color="blue" type="light">{a.country}</Tag> : <Text type="tertiary">—</Text>;
  return (
    <Space spacing={4} vertical align="start">
      <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 130 }}>{ip}</Text>
      {country}
    </Space>
  );
}

// 敏感字段（密码 / 2FA）只露图标标识是否设置；悬浮看真实值，点击复制。
function renderSecret(display: string | null | undefined, copyValue: string, label: string, icon: React.ReactNode) {
  if (!display) {
    return (
      <Tooltip content={`未设置${label}`}>
        <span style={{ color: "var(--semi-color-disabled-text)", display: "inline-flex", opacity: 0.5 }}>{icon}</span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={<span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{display}</span>}>
      <Button
        size="small"
        theme="borderless"
        type="primary"
        icon={icon}
        onClick={() => copy(copyValue || display, label)}
        aria-label={`复制${label}`}
      />
    </Tooltip>
  );
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const raw = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 会员页出库状态：已出库(蓝)+时间 / 未出库(灰)。与出库筛选同一字段 dispatch.dispatched。 */
function renderDispatchStatus(a: Account, opts?: { showTime?: boolean }) {
  const dispatched = Boolean(a.dispatch?.dispatched);
  const showTime = opts?.showTime !== false;
  const at = a.dispatch?.dispatched_at;
  const tag = dispatched ? (
    <Tag color="blue" type="light">
      已出库
    </Tag>
  ) : (
    <Tag color="grey" type="light">
      未出库
    </Tag>
  );
  if (!dispatched || !showTime || !at) {
    return tag;
  }
  return (
    <Space spacing={2} vertical align="start">
      {tag}
      <Text type="tertiary" size="small">
        {formatDateTime(at)}
      </Text>
    </Space>
  );
}

function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export type AccountPlanPage = "free" | "plus";

function accountKey(a: Account): string {
  return (a.email || a.access_token || "").trim();
}

function accountOpKey(a: Account): string {
  return (a.access_token || a.email || "").trim();
}

export default function AccountsPage({ planType }: { planType: AccountPlanPage }) {
  const isMobile = useIsMobile();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [planRefreshing, setPlanRefreshing] = useState<Set<string>>(new Set());
  const [rotatingTokens, setRotatingTokens] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // 搜索 / 筛选
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [stageFilter, setStageFilter] = useState<"" | AccountStage>("");
  const [dispatchedFilter, setDispatchedFilter] = useState<"" | "dispatched" | "undispatched">("");

  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"selected" | "filtered">("selected");
  const [exportMarkDispatched, setExportMarkDispatched] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importDragging, setImportDragging] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<AccountDetail | null>(null);

  // 读取本地文件内容填入导入文本框（点击选择 / 拖拽共用）。
  const readImportFile = (file: File | null | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result ?? ""));
      setImportFileName(file.name);
    };
    reader.onerror = () => Toast.error("读取文件失败");
    reader.readAsText(file);
  };

  // 「状态」是有效 / 失效 / 不可用三选一（与表格状态列口径一致）：
  // 有效 = Token 存活且可激活；失效 = Token 失效；不可用 = Token 存活但被标记无法激活。
  const buildParams = (overrides?: Partial<AccountListParams>): AccountListParams => ({
    q: debouncedQuery.trim() || undefined,
    view: planType,
    stage: stageFilter || undefined,
    dispatched:
      dispatchedFilter === "dispatched" ? true : dispatchedFilter === "undispatched" ? false : undefined,
    page,
    page_size: PAGE_SIZE,
    ...overrides,
  });

  const load = async (silent = false, overrides?: Partial<AccountListParams>) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchAccounts(buildParams(overrides));
      setAccounts(data.items);
      setSummary(data.summary);
      setTotal(data.total);
      setSelectedKeys((prev) => prev.filter((k) => data.items.some((a) => accountKey(a) === k)));
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "加载账户失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // 筛选条件或页码变化时重新拉取当前页。筛选项通过 onChange 重置到第 1 页。
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, stageFilter, dispatchedFilter, page, planType]);

  // 激活 / 一键运行进行中时，号池要能实时看到每个账号的激活进度：页面可见且无进行中操作时轻量轮询。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busy) return;
      void load(true);
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, stageFilter, dispatchedFilter, page, busy, planType]);

  const setRefreshFlag = (token: string, on: boolean) =>
    setRefreshing((prev) => {
      const next = new Set(prev);
      if (on) next.add(token);
      else next.delete(token);
      return next;
    });

  const setPlanRefreshFlag = (token: string, on: boolean) =>
    setPlanRefreshing((prev) => {
      const next = new Set(prev);
      if (on) next.add(token);
      else next.delete(token);
      return next;
    });

  const setRotateFlag = (token: string, on: boolean) =>
    setRotatingTokens((prev) => {
      const next = new Set(prev);
      if (on) next.add(token);
      else next.delete(token);
      return next;
    });

  // ---- 操作 ----
  const handleRefresh = async (tokens: string[]) => {
    if (!tokens.length) return;
    tokens.forEach((t) => setRefreshFlag(t, true));
    try {
      const { progress_id } = await refreshAccounts(tokens);
      const final = await new Promise<Awaited<ReturnType<typeof fetchRefreshProgress>>>((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const p = await fetchRefreshProgress(progress_id);
            if (p.done) {
              clearInterval(timer);
              resolve(p);
            }
          } catch (err) {
            clearInterval(timer);
            reject(err);
          }
        }, 500);
      });
      if (final.error) {
        Toast.error(final.error);
      } else {
        Toast.success("同步完成");
      }
      await load(true);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "同步失败");
    } finally {
      tokens.forEach((t) => setRefreshFlag(t, false));
    }
  };

  const handleRefreshPlan = async (uiKeys: string[]) => {
    if (!uiKeys.length) return;
    const tokens = uiKeys
      .map((k) => {
        const acct = accounts.find((a) => accountKey(a) === k);
        return acct ? accountOpKey(acct) : k;
      })
      .filter(Boolean);
    if (!tokens.length) return;
    uiKeys.forEach((k) => setPlanRefreshFlag(k, true));
    try {
      const { progress_id } = await refreshAccountPlans(tokens);
      const final = await new Promise<Awaited<ReturnType<typeof fetchRefreshPlanProgress>>>((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const p = await fetchRefreshPlanProgress(progress_id);
            if (p.done) {
              clearInterval(timer);
              resolve(p);
            }
          } catch (err) {
            clearInterval(timer);
            reject(err);
          }
        }, 500);
      });
      if (final.error) {
        Toast.error(final.error);
      } else {
        const counts = final.plan_counts ?? {};
        const parts = [
          `free ${counts.free ?? 0}`,
          `plus ${counts.plus ?? 0}`,
        ];
        if (counts.pro) parts.push(`pro ${counts.pro}`);
        if (counts.other) parts.push(`其他 ${counts.other}`);
        if (counts.error) parts.push(`失败 ${counts.error}`);
        const invalid = counts.invalid ?? 0;
        if (invalid) parts.push(`失效 Token ${invalid}`);
        const msg = `套餐同步完成：${parts.join("，")}`;
        if (invalid) {
          Toast.warning(`${msg}。失效账号请先「刷新 Token」后再同步`);
        } else {
          Toast.success(msg);
        }
      }
      await load(true);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "套餐同步失败");
    } finally {
      uiKeys.forEach((k) => setPlanRefreshFlag(k, false));
    }
  };

  const handleRotateToken = async (tokens: string[]) => {
    if (!tokens.length) return;
    tokens.forEach((t) => setRotateFlag(t, true));
    try {
      const { progress_id } = await refreshAccountTokens(tokens);
      const final = await new Promise<Awaited<ReturnType<typeof fetchRefreshTokenProgress>>>((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const p = await fetchRefreshTokenProgress(progress_id);
            if (p.done) {
              clearInterval(timer);
              resolve(p);
            }
          } catch (err) {
            clearInterval(timer);
            reject(err);
          }
        }, 500);
      });
      if (final.error) {
        Toast.error(final.error);
      } else {
        const changed = final.status_counts?.已变化 ?? final.status_counts?.成功 ?? 0;
        const unchanged = final.status_counts?.未变化 ?? 0;
        const fail = final.status_counts?.失败 ?? 0;
        const skip = final.status_counts?.跳过 ?? 0;
        const parts = [`已变化 ${changed}`, `未变化 ${unchanged}`];
        if (fail) parts.push(`失败 ${fail}`);
        if (skip) parts.push(`跳过 ${skip}`);
        const summaryText = parts.join("，");
        const errorHints = (final.result?.errors || [])
          .map((item) => String((item as { error?: string }).error || "").trim())
          .filter(Boolean);
        const reasonText = errorHints.length ? `：${errorHints.slice(0, 3).join("；")}` : "";
        if (fail > 0) {
          Toast.warning(`Token 刷新完成：${summaryText}${reasonText}`);
        } else if (skip > 0) {
          Toast.warning(`Token 刷新完成：${summaryText}${reasonText}`);
        } else if (changed > 0) {
          Toast.success(`Token 已刷新：${summaryText}`);
        } else {
          Toast.info(`Token 刷新完成：${summaryText}`);
        }
      }
      await load(true);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "刷新 Token 失败");
    } finally {
      tokens.forEach((t) => setRotateFlag(t, false));
    }
  };

  const handleOpenDetail = async (a: Account) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailLoading(true);
    try {
      const data = await fetchAccountDetail({
        access_token: a.access_token || undefined,
        email: a.email || undefined,
      });
      setDetail(data.item);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "加载账号详情失败");
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async (tokens: string[]) => {
    if (!tokens.length) return;
    setBusy(true);
    try {
      const data = await deleteAccounts(tokens);
      await load(true);
      Toast.success(`删除 ${data.removed ?? 0} 个账户`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const handleMarkUsed = async (tokens: string[], used: boolean) => {
    if (!tokens.length) {
      Toast.warning("请先选择账号");
      return;
    }
    setBusy(true);
    try {
      const data = await markAccountsUsed(tokens, used);
      await load(true);
      Toast.success(`已标记 ${data.updated} 个为${used ? "已出库" : "未出库"}`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "标记失败");
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = async (scope: "selected" | "filtered", markDispatched = false) => {
    setBusy(true);
    try {
      let tokens: string[];
      if (scope === "selected") {
        if (!selectedKeys.length) {
          Toast.warning("请先选择账号");
          return;
        }
        tokens = selectedKeys;
      } else {
        const data = await fetchAccounts({
          ...buildParams(),
          page: 1,
          page_size: Math.max(total, 1),
        });
        tokens = data.items.map((a) => accountOpKey(a)).filter(Boolean);
        if (!tokens.length) {
          Toast.warning("没有可导出的账号");
          return;
        }
      }
      const text = await exportAccounts(tokens, "json");
      if (!text.trim()) {
        Toast.warning("没有可导出的账号");
        return;
      }
      downloadText(text, `accounts-${planType}-${Date.now()}.json`);
      Toast.success(scope === "selected" ? `已导出选中 ${tokens.length} 个账号` : `已导出当前筛选 ${tokens.length} 个账号`);
      if (markDispatched && planType === "plus") {
        await markAccountsUsed(tokens, true);
        await load(true);
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  const openExportDialog = (scope: "selected" | "filtered") => {
    if (scope === "selected" && !selectedKeys.length) {
      Toast.warning("请先选择账号");
      return;
    }
    if (planType === "plus") {
      setExportScope(scope);
      setExportMarkDispatched(false);
      setExportOpen(true);
      return;
    }
    void handleExportJson(scope);
  };

  const handleExportConfirm = async () => {
    await handleExportJson(exportScope, exportMarkDispatched);
    setExportOpen(false);
  };

  const importValidation = useMemo(() => validateAccountImport(importText), [importText]);

  const handleImport = async () => {
    const blockMsg = importSubmitGuard(importValidation, "请粘贴要导入的 access_token 或 JSON");
    if (blockMsg) {
      Toast.warning(blockMsg);
      return;
    }
    const raw = importText.trim();
    let tokens: string[] = [];
    let accounts: AccountImportPayload[] = [];
    let importBlobText = "";
    // JSON（[...] 或 {...}）整包导入，携带 proxy/country 等字段；
    // 账号池格式交后端 parse_import_blob 解析；否则按纯 access_token 逐行导入。
    if (raw.startsWith("[") || raw.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        Toast.error("JSON 解析失败，请检查文件格式");
        return;
      }
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      accounts = arr.filter(
        (it): it is AccountImportPayload =>
          !!it &&
          typeof it === "object" &&
          typeof (it as { access_token?: unknown }).access_token === "string" &&
          !!(it as { access_token?: string }).access_token,
      );
      tokens = accounts.map((a) => accountOpKey(a)).filter(Boolean);
    } else if (isAccountPoolImportText(raw)) {
      importBlobText = raw;
    } else {
      tokens = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    setBusy(true);
    try {
      const data = await createAccounts(tokens, accounts, importBlobText);
      setImportOpen(false);
      setImportText("");
      setImportFileName("");
      await load(true);
      Toast.success(`导入完成，新增 ${data.added ?? 0} 个，正在后台校验…`);
      // 导入已即时返回；账号校验在后台异步进行，这里轮询进度并在完成后刷新列表。
      const progressId = data.refresh_progress_id;
      if (progressId) {
        void (async () => {
          try {
            await new Promise<void>((resolve) => {
              const timer = setInterval(async () => {
                try {
                  const p = await fetchRefreshProgress(progressId);
                  if (p.done) {
                    clearInterval(timer);
                    resolve();
                  }
                } catch {
                  clearInterval(timer);
                  resolve();
                }
              }, 800);
            });
            await load(true);
          } catch {
            /* 后台校验失败不打断导入流程 */
          }
        })();
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  // ---- 列 ----
  const columns: ColumnProps<Account>[] = [
    {
      title: "邮箱",
      dataIndex: "email",
      width: 300,
      fixed: "left",
      render: (email: string | null) =>
        email ? (
          <Space spacing={4} style={{ maxWidth: "100%" }}>
            <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 220 }}>
              {email}
            </Text>
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(email, "邮箱")} />
          </Space>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "Token",
      width: 150,
      render: (_: unknown, a: Account) => {
        const tk = a.access_token || "";
        return (
          <Text type="tertiary" style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>
            ···{tk.slice(-10)}
          </Text>
        );
      },
    },
    {
      title: "状态",
      width: 110,
      render: (_: unknown, a: Account) => stageTag(
        a,
        refreshing.has(accountKey(a)) || rotatingTokens.has(accountKey(a)),
      ),
    },
    {
      title: "激活",
      width: 90,
      render: (_: unknown, a: Account) => activationStatusTag(a),
    },
    {
      title: "套餐",
      width: 90,
      render: (_: unknown, a: Account) => planTypeTag(
        a.subscription_tier,
        planRefreshing.has(accountKey(a)),
      ),
    },
    ...(planType === "plus"
      ? [{
          title: "出库状态",
          width: 120,
          render: (_: unknown, a: Account) => renderDispatchStatus(a),
        } as ColumnProps<Account>]
      : []),
    {
      title: "出口IP/国家",
      width: 140,
      render: (_: unknown, a: Account) => renderGeo(a),
    },
    {
      title: "密码/2FA",
      width: 100,
      render: (_: unknown, a: Account) => (
        <Space spacing={4}>
          {renderSecret(a.password, a.password || "", "密码", <IconKey />)}
          {renderSecret(a.totp_secret, a.totp_secret || "", "2FA 密钥", <IconShield />)}
        </Space>
      ),
    },
    {
      title: "错误信息",
      width: 200,
      render: (_: unknown, a: Account) => {
        const msg = a.last_error || "";
        return msg ? (
          <Text type="danger" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 190 }}>
            {msg}
          </Text>
        ) : (
          <Text type="tertiary" size="small">-</Text>
        );
      },
    },
    {
      title: "指纹Seed",
      dataIndex: "fingerprint_seed",
      width: 130,
      render: (v: string | number | null) =>
        v ? (
          <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 120, fontFamily: "monospace" }}>
            {String(v)}
          </Text>
        ) : (
          <Text type="tertiary" size="small">-</Text>
        ),
    },
    {
      title: "注册日期",
      dataIndex: "registered_at",
      width: 140,
      render: (_: string | null, a: Account) => (
        <Text type="tertiary" size="small">{formatDateTime(a.registered_at || a.created_at)}</Text>
      ),
    },
    ...(planType === "plus"
      ? [{
          title: "激活时间",
          dataIndex: "activated_at",
          width: 140,
          render: (_: string | null, a: Account) => (
            <Text type="tertiary" size="small">{formatDateTime(a.activated_at || a.plus_activated_at)}</Text>
          ),
        } as ColumnProps<Account>]
      : []),
    {
      title: "更新时间",
      dataIndex: "updated_at",
      width: 140,
      render: (_: string | null, a: Account) => (
        <Text type="tertiary" size="small">{formatDateTime(a.updated_at || a.last_token_refresh_at)}</Text>
      ),
    },
    {
      title: "操作",
      width: 250,
      fixed: "right",
      render: (_: unknown, a: Account) => {
        const key = accountKey(a);
        return (
          <Space spacing={2}>
            <Button
              size="small"
              theme="borderless"
              icon={<IconInfoCircle />}
              title="详情"
              onClick={() => void handleOpenDetail(a)}
            />
            <Button
              size="small"
              theme="borderless"
              icon={<IconMail />}
              title={a.mail_link ? "收邮件（打开邮箱链接）" : "无邮箱链接"}
              disabled={!a.mail_link}
              onClick={() => a.mail_link && window.open(a.mail_link, "_blank", "noopener")}
            />
            <Button
              size="small"
              theme="borderless"
              icon={<IconRefresh />}
              title="刷新 Token"
              loading={rotatingTokens.has(key)}
              onClick={() => void handleRotateToken([accountOpKey(a)])}
            />
            <Button
              size="small"
              theme="borderless"
              icon={<IconSync />}
              title="同步信息"
              loading={refreshing.has(key)}
              onClick={() => void handleRefresh([accountOpKey(a)])}
            />
            <Popconfirm title="删除该账号？" onConfirm={() => void handleDelete([accountKey(a)])}>
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} title="删除" />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const allOnPageSelected = accounts.length > 0 && accounts.every((a) => selectedKeys.includes(accountKey(a)));
  const toggleSelectAll = () =>
    setSelectedKeys(allOnPageSelected ? [] : accounts.map((a) => accountKey(a)).filter(Boolean));
  const toggleOne = (token: string) =>
    setSelectedKeys((prev) => (prev.includes(token) ? prev.filter((t) => t !== token) : [...prev, token]));

  const metricCards =
    planType === "free"
      ? [
          { label: "总数", value: summary.total },
          { label: "已注册", value: summary.registered ?? 0, color: "var(--semi-color-success)" },
        ]
      : [
          { label: "总数", value: summary.total },
          { label: "未出库", value: summary.undispatched ?? 0, color: "var(--semi-color-primary)" },
          { label: "激活中", value: summary.activating ?? 0, color: "var(--semi-color-warning)" },
          { label: "已激活", value: summary.plus_activated ?? 0, color: "var(--semi-color-success)" },
        ];

  const stageOptions =
    planType === "free"
      ? [
          { label: "全部状态", value: "" },
          { label: "已注册", value: "registered" },
        ]
      : [
          { label: "全部状态", value: "" },
          { label: "激活中", value: "activating" },
          { label: "已激活", value: "plus_activated" },
        ];

  const filterControls = (
    <>
      <Input
        prefix={<IconSearch />}
        value={query}
        onChange={(v) => {
          setQuery(v);
          setPage(1);
        }}
        showClear
        placeholder="搜索邮箱 / 密码 / Token"
        style={{ width: isMobile ? "100%" : 240 }}
      />
      <Select
        value={stageFilter}
        onChange={(v) => {
          setStageFilter((v as AccountStage | "") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={stageOptions}
      />
      {planType === "plus" ? (
        <Select
          value={dispatchedFilter}
          onChange={(v) => {
            setDispatchedFilter((v as "" | "dispatched" | "undispatched") ?? "");
            setPage(1);
          }}
          style={{ width: isMobile ? "100%" : 130 }}
          optionList={[
            { label: "全部出库", value: "" },
            { label: "未出库", value: "undispatched" },
            { label: "已出库", value: "dispatched" },
          ]}
        />
      ) : null}
    </>
  );
  const activeFilterCount =
    (query.trim() ? 1 : 0) + (stageFilter ? 1 : 0) + (dispatchedFilter ? 1 : 0);

  return (
    <div>
      <StatCards mobile={isMobile} items={metricCards} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16, alignItems: "center", justifyContent: "space-between" }}>
        {isMobile ? (
          <div style={{ width: "100%" }}>
            <MobileFilters activeCount={activeFilterCount}>{filterControls}</MobileFilters>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>{filterControls}</div>
        )}

        {/* 列表操作：刷新 / 同步(导入·导出 JSON)；选中时可删除 */}
        <Space wrap>
          {selectedKeys.length > 0 ? (
            <>
              <Text type="tertiary">已选 {selectedKeys.length}</Text>
              <Popconfirm title={`删除选中的 ${selectedKeys.length} 个账号？`} onConfirm={() => void handleDelete(selectedKeys)}>
                <Button size="small" type="danger" icon={<IconDelete />}>
                  删除选中
                </Button>
              </Popconfirm>
              {planType === "plus" ? (
                <>
                  <Popconfirm
                    title={`将选中的 ${selectedKeys.length} 个账号标记为已出库？`}
                    onConfirm={() => void handleMarkUsed(selectedKeys, true)}
                  >
                    <Button size="small" type="primary" theme="light" loading={busy}>
                      标记出库
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={`撤销选中的 ${selectedKeys.length} 个账号的出库标记？`}
                    onConfirm={() => void handleMarkUsed(selectedKeys, false)}
                  >
                    <Button size="small" type="warning" theme="light" loading={busy}>
                      撤销出库
                    </Button>
                  </Popconfirm>
                </>
              ) : null}
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={selectedKeys.some((k) => rotatingTokens.has(k))}
                onClick={() => void handleRotateToken(selectedKeys.map((k) => {
                  const acct = accounts.find((a) => accountKey(a) === k);
                  return acct ? accountOpKey(acct) : k;
                }))}
              >
                刷新 Token
              </Button>
              <Button
                size="small"
                icon={<IconSync />}
                loading={selectedKeys.some((k) => planRefreshing.has(k))}
                onClick={() => void handleRefreshPlan(selectedKeys)}
              >
                同步套餐
              </Button>
              <span style={{ width: 1, height: 18, background: "var(--semi-color-border)", display: "inline-block" }} />
            </>
          ) : null}
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Dropdown
            trigger="click"
            render={
              <Dropdown.Menu>
                <Dropdown.Item icon={<IconUpload />} onClick={() => setImportOpen(true)}>
                  导入
                </Dropdown.Item>
                <Dropdown.Item icon={<IconDownload />} onClick={() => openExportDialog("selected")}>
                  导出选中
                </Dropdown.Item>
                <Dropdown.Item icon={<IconDownload />} onClick={() => openExportDialog("filtered")}>
                  导出全部
                </Dropdown.Item>
              </Dropdown.Menu>
            }
          >
            <Button icon={<IconSync />} loading={busy}>
              同步
            </Button>
          </Dropdown>
        </Space>
      </div>

      {isMobile ? (
        <AccountMobileList
          accounts={accounts}
          loading={loading}
          selected={selectedKeys}
          allSelected={allOnPageSelected}
          refreshing={refreshing}
          planRefreshing={planRefreshing}
          rotatingTokens={rotatingTokens}
          showDispatchStatus={planType === "plus"}
          onToggleAll={toggleSelectAll}
          onToggle={toggleOne}
          onRefresh={(t) => void handleRefresh([t])}
          onRotateToken={(t) => void handleRotateToken([t])}
          onDetail={(a) => void handleOpenDetail(a)}
          onDelete={(t) => void handleDelete([t])}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      ) : (
        <Table
          columns={columns}
          dataSource={accounts}
          loading={loading}
          rowKey={(a) => accountKey(a as Account)}
          tableLayout="fixed"
          scroll={{ x: planType === "plus" ? 1980 : 1860 }}
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total,
            onPageChange: setPage,
          }}
          rowSelection={{
            fixed: true,
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys((keys ?? []) as string[]),
          }}
          empty={`暂无账号，可手动导入，或在${navRef("register")}中自动注册。`}
        />
      )}

      {/* 导入弹窗：选择「导出」下载的 JSON 文件导入（也可直接粘贴内容）。 */}
      <Modal
        title="导入账号"
        visible={importOpen}
        onCancel={() => {
          setImportOpen(false);
          setImportFileName("");
          setImportDragging(false);
        }}
        onOk={() => void handleImport()}
        okText="导入"
        confirmLoading={busy}
        maskClosable={false}
        fullScreen={isMobile}
      >
        <Text type="tertiary">
          支持 JSON（含完整字段）、账号池文本每行 <Text code>邮箱 + 分隔符 + 密码/2FA/token</Text>（分隔符至少两个连字符 <Text code>-</Text>）、或每行一个 access_token。
        </Text>
        <input
          type="file"
          accept=".json,application/json,.txt,text/plain"
          style={{ display: "none" }}
          ref={importFileRef}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // 允许再次选择同一文件
            readImportFile(file);
          }}
        />
        {/* 点击选择 + 拖拽上传：拖入 JSON 文件即读取内容。 */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => importFileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") importFileRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!importDragging) setImportDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setImportDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setImportDragging(false);
            readImportFile(e.dataTransfer.files?.[0]);
          }}
          style={{
            marginTop: 8,
            padding: "20px 12px",
            border: `1px dashed ${importDragging ? "var(--semi-color-primary)" : "var(--semi-color-border)"}`,
            borderRadius: 6,
            textAlign: "center",
            cursor: "pointer",
            background: importDragging ? "var(--semi-color-primary-light-default)" : "var(--semi-color-fill-0)",
            transition: "all .15s",
          }}
        >
          <IconUpload style={{ fontSize: 22, color: "var(--semi-color-text-2)" }} />
          <div style={{ marginTop: 6 }}>
            <Text>点击选择文件，或将 JSON 文件拖拽到此处</Text>
          </div>
          <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: "100%", display: "block", marginTop: 4 }}>
            {importFileName ? `已选择：${importFileName}` : "未选择文件"}
          </Text>
        </div>
        <TextArea
          value={importText}
          onChange={(v) => {
            setImportText(v);
            if (importFileName) setImportFileName("");
          }}
          rows={8}
          style={{ marginTop: 8, fontFamily: "monospace" }}
          placeholder={"选择文件后内容显示在此，或直接粘贴 JSON / access_token（每行一个）..."}
        />
        <ImportCountHint count={importValidation.validCount} issues={importValidation.issues} unit="个" />
      </Modal>

      <Modal
        title={exportScope === "selected" ? "导出选中账号" : "导出全部账号"}
        visible={exportOpen}
        onCancel={() => setExportOpen(false)}
        onOk={() => void handleExportConfirm()}
        okText="导出"
        confirmLoading={busy}
        maskClosable={false}
      >
        <Text type="tertiary">
          {exportScope === "selected"
            ? `将导出已选中的 ${selectedKeys.length} 个账号为 JSON 文件。`
            : "将按当前筛选条件导出全部匹配账号为 JSON 文件。"}
        </Text>
        <div style={{ marginTop: 12 }}>
          <Checkbox checked={exportMarkDispatched} onChange={(e) => setExportMarkDispatched(!!e.target?.checked)}>
            导出后标记为已出库
          </Checkbox>
        </div>
      </Modal>

      <SideSheet
        title={detail?.email ? `账号详情 · ${detail.email}` : "账号详情"}
        visible={detailOpen}
        onCancel={() => {
          setDetailOpen(false);
          setDetail(null);
        }}
        width={isMobile ? "100%" : 560}
        bodyStyle={{ paddingBottom: 24 }}
      >
        {detailLoading ? (
          <div style={{ padding: 40, textAlign: "center" }}>
            <Spin />
          </div>
        ) : detail ? (
          <AccountDetailBody detail={detail} />
        ) : (
          <Text type="tertiary">暂无数据</Text>
        )}
      </SideSheet>
    </div>
  );
}

function DetailField({
  label,
  value,
  mono,
  copyLabel,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  copyLabel?: string;
}) {
  const text = String(value || "").trim();
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <Text type="tertiary" size="small">
          {label}
        </Text>
        {text && copyLabel ? (
          <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(text, copyLabel)} />
        ) : null}
      </div>
      {text ? (
        <Text
          style={{
            fontFamily: mono ? "monospace" : undefined,
            fontSize: mono ? 12 : 13,
            wordBreak: "break-all",
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </Text>
      ) : (
        <Text type="tertiary">—</Text>
      )}
    </div>
  );
}

function AccountDetailBody({ detail }: { detail: AccountDetail }) {
  const session = detail.browser_session;
  const cookies = Array.isArray(session?.cookies) ? session!.cookies! : [];
  const sessionJson = session ? JSON.stringify(session, null, 2) : "";
  return (
    <div>
      <DetailField label="邮箱" value={detail.email} copyLabel="邮箱" />
      <DetailField label="Access Token" value={detail.access_token} mono copyLabel="Access Token" />
      <DetailField label="Refresh Token" value={detail.refresh_token} mono copyLabel="Refresh Token" />
      <DetailField label="ID Token" value={detail.id_token} mono copyLabel="ID Token" />
      <DetailField label="密码" value={detail.password} copyLabel="密码" />
      <DetailField label="2FA 密钥" value={detail.totp_secret} mono copyLabel="2FA 密钥" />
      <DetailField label="代理" value={detail.proxy} mono copyLabel="代理" />
      <DetailField label="指纹 Seed" value={detail.fingerprint_seed != null ? String(detail.fingerprint_seed) : ""} />
      <DetailField label="Session 更新时间" value={detail.browser_session_at || ""} />
      <DetailField label="最近刷新 Token" value={detail.last_token_rotate_at || detail.last_token_refresh_at || ""} />
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <Text type="tertiary" size="small">
            Browser Session（Cookies {cookies.length}）
          </Text>
          {sessionJson ? (
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(sessionJson, "Browser Session")} />
          ) : null}
        </div>
        {sessionJson ? (
          <TextArea
            value={sessionJson}
            readonly
            autosize={{ minRows: 8, maxRows: 20 }}
            style={{ fontFamily: "monospace", fontSize: 11 }}
          />
        ) : (
          <Text type="tertiary">无 browser_session（尚未通过登录/刷新写入）</Text>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── 手机端卡片流 ─────────────────────────

type AccountMobileListProps = {
  accounts: Account[];
  loading: boolean;
  selected: string[];
  allSelected: boolean;
  refreshing: Set<string>;
  planRefreshing: Set<string>;
  rotatingTokens: Set<string>;
  showDispatchStatus?: boolean;
  onToggleAll: () => void;
  onToggle: (token: string) => void;
  onRefresh: (token: string) => void;
  onRotateToken: (token: string) => void;
  onDetail: (account: Account) => void;
  onDelete: (token: string) => void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

function AccountMobileList({
  accounts,
  loading,
  selected,
  allSelected,
  refreshing,
  planRefreshing,
  rotatingTokens,
  showDispatchStatus = false,
  onToggleAll,
  onToggle,
  onRefresh,
  onRotateToken,
  onDetail,
  onDelete,
  page,
  pageSize,
  total,
  onPageChange,
}: AccountMobileListProps) {
  if (!loading && accounts.length === 0) {
    return (
      <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
        <Text type="tertiary">暂无账号，可手动导入，或在{navRef("register")}中自动注册。</Text>
      </Card>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8, paddingLeft: 4 }}>
        <Checkbox checked={allSelected} onChange={onToggleAll}>
          <Text type="tertiary" size="small">
            全选本页
          </Text>
        </Checkbox>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {accounts.map((a) => {
          const key = accountKey(a);
          const checked = selected.includes(key);
          const token = a.access_token || "";
          const statusNode = stageTag(a, refreshing.has(key) || rotatingTokens.has(key));
          const dispatchAt = a.dispatch?.dispatched_at;
          return (
            <Card
              key={key}
              bodyStyle={{ padding: 14 }}
              style={{ borderColor: checked ? "var(--semi-color-primary)" : undefined }}
            >
              {/* 顶行：勾选 + 邮箱 + 状态 (+ 出库状态，仅会员) */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Checkbox checked={checked} onChange={() => onToggle(key)} />
                {a.email ? (
                  <Text
                    strong
                    ellipsis={{ showTooltip: true }}
                    style={{ flex: 1, fontSize: 15 }}
                    onClick={() => copy(a.email as string, "邮箱")}
                  >
                    {a.email}
                  </Text>
                ) : (
                  <Text type="tertiary" style={{ flex: 1 }}>
                    无邮箱
                  </Text>
                )}
                <Space spacing={4} wrap>
                  {statusNode}
                  {activationStatusTag(a)}
                  {planTypeTag(a.subscription_tier, planRefreshing.has(key))}
                  {showDispatchStatus ? renderDispatchStatus(a, { showTime: false }) : null}
                </Space>
              </div>

              {/* 标签行：出口信息 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {renderGeo(a)}
              </div>

              {/* 信息行：Token / 密码 / 2FA / 更新时间 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <Text type="tertiary" style={{ fontFamily: "monospace", fontSize: 12 }}>
                  ···{token.slice(-10)}
                </Text>
                {renderSecret(a.password, a.password || "", "密码", <IconKey />)}
                {renderSecret(a.totp_secret, a.totp_secret || "", "2FA 密钥", <IconShield />)}
                <Text type="tertiary" size="small" style={{ marginLeft: "auto" }}>
                  {formatDateTime(a.last_token_refresh_at)}
                </Text>
              </div>
              {showDispatchStatus && a.dispatch?.dispatched && dispatchAt ? (
                <div style={{ marginTop: 6 }}>
                  <Text type="tertiary" size="small">
                    出库 {formatDateTime(dispatchAt)}
                  </Text>
                </div>
              ) : null}

              {/* 操作行 */}
              <div style={{ display: "flex", gap: 4, marginTop: 12, justifyContent: "space-between" }}>
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconInfoCircle />}
                  title="详情"
                  onClick={() => onDetail(a)}
                />
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconMail />}
                  disabled={!a.mail_link}
                  title={a.mail_link ? "收邮件" : "无邮箱链接"}
                  onClick={() => a.mail_link && window.open(a.mail_link, "_blank", "noopener")}
                />
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconRefresh />}
                  title="刷新 Token"
                  loading={rotatingTokens.has(key)}
                  onClick={() => onRotateToken(accountOpKey(a))}
                />
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconSync />}
                  title="同步信息"
                  loading={refreshing.has(key)}
                  onClick={() => onRefresh(accountOpKey(a))}
                />
                <Popconfirm title="删除该账号？" onConfirm={() => onDelete(key)}>
                  <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} title="删除" />
                </Popconfirm>
              </div>
            </Card>
          );
        })}
      </div>

      {total > pageSize ? (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <Pagination total={total} currentPage={page} pageSize={pageSize} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}
