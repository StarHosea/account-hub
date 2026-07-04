import { useEffect, useRef, useState } from "react";
import {
  Table,
  Card,
  Button,
  Tag,
  Toast,
  Modal,
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
  IconEdit,
  IconMail,
  IconKey,
  IconCopy,
  IconTickCircle,
  IconSearch,
} from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  fetchAccounts,
  refreshAccounts,
  fetchRefreshProgress,
  deleteAccounts,
  updateAccount,
  createAccounts,
  exportAccounts,
  exportAccountPool,
  markAccountsUsed,
  markPlusAvailable,
  revokeActivation,
  type Account,
  type AccountImportPayload,
  type AccountStatus,
  type AccountSummary,
  type AccountListParams,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useIsMobile } from "@/lib/use-is-mobile";
import { copyToClipboard as copy } from "@/lib/clipboard";
import { StatCards } from "@/components/StatCards";
import { MobileFilters } from "@/components/MobileFilters";
import { log, useLogStore } from "@/store/logs";

const { Title, Text } = Typography;

const PAGE_SIZE = 10;
const EMPTY_SUMMARY: AccountSummary = { total: 0, alive: 0, dead: 0, activated: 0, pending: 0, needs_review: 0, unused: 0 };

// 真实订阅档位（OpenAI 返回的 type），与「状态」的激活流程区分开。供表格与卡片共用。
function tierTag(type: string | null | undefined) {
  // 需求口径：账号已激活成功 Plus → 显示 Plus，否则一律 Free。
  const isPlus = String(type ?? "").trim().toLowerCase() === "plus";
  return (
    <Tag color={(isPlus ? "amber" : "grey") as never} type="light">
      {isPlus ? "Plus" : "Free"}
    </Tag>
  );
}

// Plus 激活流程状态（activation_service 维护，写在账号的 plus_* 字段里），与真实档位 type 区分。
// 账号有效性 + 可用性 + 进行中态（校验）合并为一个「状态」。供表格与卡片共用。
function accountStatusInfo(a: Account, isRefreshing: boolean) {
  let text = "有效";
  let color: string = "green";
  let spin = false;
  if (isRefreshing) [text, color, spin] = ["校验中", "blue", true];
  else if (a.status === "异常" || a.status === "禁用") [text, color] = ["失效", "red"];
  else if (a.plus_unavailable) [text, color] = ["不可用", "red"];
  return { text, color, spin };
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

function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AccountsPage() {
  const isMobile = useIsMobile();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // 搜索 / 筛选
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [statusFilter, setStatusFilter] = useState<"" | "valid" | "dead" | "unavailable">("valid");
  const [planFilter, setPlanFilter] = useState<"" | "free" | "plus">("");
  // 激活态筛选：默认「全部」，展示注册/导入入库的所有账号；可切到「已激活」等仅看对应状态。
  const [activationFilter, setActivationFilter] = useState<"" | "activated" | "pending" | "activating" | "failed" | "review">("");
  const [usedFilter, setUsedFilter] = useState<"" | "used" | "unused">("");

  const [editTarget, setEditTarget] = useState<Account | null>(null);
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editProxy, setEditProxy] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importDragging, setImportDragging] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

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

  const openLog = useLogStore((s) => s.setOpen);
  // 按 token 反查邮箱，作为日志 scope，定位到具体账号。
  const emailOf = (token: string) => accounts.find((a) => a.access_token === token)?.email ?? `${token.slice(0, 8)}…`;

  // 「状态」是有效 / 失效 / 不可用三选一（与表格状态列口径一致）：
  // 有效 = Token 存活且可激活；失效 = Token 失效；不可用 = Token 存活但被标记无法激活。
  const buildParams = (overrides?: Partial<AccountListParams>): AccountListParams => ({
    q: debouncedQuery.trim() || undefined,
    status: statusFilter === "dead" ? "dead" : statusFilter === "" ? undefined : "alive",
    avail:
      statusFilter === "valid" ? "available" : statusFilter === "unavailable" ? "unavailable" : undefined,
    plan: planFilter || undefined,
    // 激活态由筛选控制，默认「全部」：注册/导入入库的账号（含未激活）都会展示，与统计卡口径一致。
    activation: activationFilter || undefined,
    used: usedFilter ? usedFilter === "used" : undefined,
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
      setSelectedKeys((prev) => prev.filter((k) => data.items.some((a) => a.access_token === k)));
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
  }, [debouncedQuery, statusFilter, planFilter, activationFilter, usedFilter, page]);

  // 激活 / 一键运行进行中时，号池要能实时看到每个账号的激活进度：页面可见且无进行中操作时轻量轮询。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busy) return;
      void load(true);
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, statusFilter, planFilter, usedFilter, page, busy]);

  const setRefreshFlag = (token: string, on: boolean) =>
    setRefreshing((prev) => {
      const next = new Set(prev);
      if (on) next.add(token);
      else next.delete(token);
      return next;
    });

  // ---- 操作 ----
  const handleRefresh = async (tokens: string[]) => {
    if (!tokens.length) return;
    const scope = tokens.length === 1 ? `校验 · ${emailOf(tokens[0])}` : `批量校验 · ${tokens.length} 个账号`;
    tokens.forEach((t) => setRefreshFlag(t, true));
    log.info(scope, "开始校验/刷新");
    try {
      const { progress_id } = await refreshAccounts(tokens);
      const final = await new Promise<Awaited<ReturnType<typeof fetchRefreshProgress>>>((resolve, reject) => {
        let lastProcessed = -1;
        const timer = setInterval(async () => {
          try {
            const p = await fetchRefreshProgress(progress_id);
            if (p.processed !== lastProcessed) {
              lastProcessed = p.processed;
              log.info(scope, `进度 ${p.processed}/${p.total}`);
            }
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
      // 逐账号打印结果，失败的明确标红。
      (final.results ?? []).forEach((r) => {
        const who = emailOf(r.token);
        if (r.error) log.error(scope, `${who}：${r.error}`);
        else log.info(scope, `${who}：${r.status}`);
      });
      if (final.error) {
        log.error(scope, final.error);
        openLog(true);
        Toast.error(final.error);
      } else {
        log.success(scope, "校验完成");
        Toast.success("刷新完成");
      }
      await load(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "刷新失败";
      log.error(scope, msg);
      openLog(true);
      Toast.error(msg);
    } finally {
      tokens.forEach((t) => setRefreshFlag(t, false));
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

  const handleMarkPlusAvailable = async (tokens: string[], available: boolean) => {
    if (!tokens.length) {
      Toast.warning("请先选择账号");
      return;
    }
    setBusy(true);
    try {
      const data = await markPlusAvailable(tokens, available);
      await load(true);
      if (data.updated) {
        Toast.success(`已标记 ${data.updated} 个账号激活${available ? "可用" : "不可用"}`);
      } else {
        Toast.info("没有需要变更的账号");
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "标记失败");
    } finally {
      setBusy(false);
    }
  };

  // 危险操作：批量撤销激活，把选中账号的激活状态复位为未激活（不动真实档位 type）。
  const handleRevokeActivation = async (tokens: string[]) => {
    if (!tokens.length) {
      Toast.warning("请先选择账号");
      return;
    }
    setBusy(true);
    try {
      const data = await revokeActivation(tokens);
      await load(true);
      if (data.updated) {
        Toast.success(`已撤销 ${data.updated} 个账号的激活状态`);
      } else {
        Toast.info("没有需要变更的账号");
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  };

  // 迁移导出：选中则导出选中，未选中则导出全部；下载完整 JSON（含代理），不标记已出库。
  const handleExportMigration = async () => {
    setBusy(true);
    try {
      const text = await exportAccounts(selectedKeys, "json");
      if (!text.trim()) {
        Toast.warning("没有可导出的账号");
        return;
      }
      downloadText(text, `accounts-migration-${Date.now()}.json`);
      Toast.success(
        `已导出迁移文件${selectedKeys.length ? `（选中 ${selectedKeys.length} 个）` : "（全部）"}`,
      );
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");    } finally {
      setBusy(false);
    }
  };

  // 账号池导出：每行 `邮箱---密码---2FA--Accesstoken`（与导入互为逆操作）。
  const handleExportPool = async () => {
    setBusy(true);
    try {
      const text = await exportAccountPool(selectedKeys);
      if (!text.trim()) {
        Toast.warning("没有可导出的账号");
        return;
      }
      downloadText(text, `accounts-pool-${Date.now()}.txt`);
      Toast.success(
        `已导出账号（邮箱格式）${selectedKeys.length ? `（选中 ${selectedKeys.length} 个）` : "（全部）"}`,
      );
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (a: Account) => {
    setEditTarget(a);
    setEditStatus(a.status);
    setEditProxy(a.proxy ?? "");
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    setBusy(true);
    try {
      await updateAccount(editTarget.access_token, {
        status: editStatus,
        proxy: editProxy.trim(),
      });
      await load(true);
      setEditTarget(null);
      Toast.success("已更新");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    const raw = importText.trim();
    if (!raw) {
      Toast.warning("请粘贴要导入的 access_token 或迁移 JSON");
      return;
    }
    let tokens: string[] = [];
    let accounts: AccountImportPayload[] = [];
    let importBlobText = "";
    // 迁移 JSON（[...] 或 {...}）整包导入，携带 proxy/country 等字段；
    // 含 `---` 的按账号池格式 `邮箱---密码---2FA--Accesstoken` 交后端解析；否则按纯 access_token 逐行导入。
    if (raw.startsWith("[") || raw.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        Toast.error("JSON 解析失败，请检查迁移文件格式");
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
      tokens = accounts.map((a) => a.access_token);
      if (!accounts.length) {
        Toast.warning("JSON 里没有找到带 access_token 的账号");
        return;
      }
    } else if (raw.includes("---")) {
      // 账号池格式：整块交给后端 parse_import_blob 解析（邮箱/密码/2FA/AccessToken）。
      importBlobText = raw;
    } else {
      tokens = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!tokens.length) {
        Toast.warning("请粘贴要导入的 access_token");
        return;
      }
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
        const scope = "导入校验";
        void (async () => {
          try {
            let lastProcessed = -1;
            await new Promise<void>((resolve) => {
              const timer = setInterval(async () => {
                try {
                  const p = await fetchRefreshProgress(progressId);
                  if (p.processed !== lastProcessed) {
                    lastProcessed = p.processed;
                    log.info(scope, `校验进度 ${p.processed}/${p.total}`);
                  }
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
            log.success(scope, "导入账号校验完成");
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
      title: "套餐",
      width: 90,
      render: (_: unknown, a: Account) => tierTag(a.type),
    },
    {
      title: "状态",
      width: 130,
      render: (_: unknown, a: Account) => {
        const { text, color, spin } = accountStatusInfo(
          a,
          refreshing.has(a.access_token),
        );
        return (
          <Space spacing={4}>
            {spin ? <Spin size="small" /> : null}
            <Tag color={color as never} type="light">
              {text}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: "密码",
      dataIndex: "password",
      width: 80,
      render: (pwd: string | null) => renderSecret(pwd, pwd || "", "密码", <IconKey />),
    },
    {
      title: "2FA",
      width: 70,
      render: (_: unknown, a: Account) =>
        renderSecret(a.totp_secret, a.totp_secret || "", "2FA 密钥", <IconShield />),
    },
    {
      title: "出库信息",
      dataIndex: "used",
      width: 100,
      render: (used: boolean) =>
        used ? (
          <Tag color="grey" type="light">
            已出库
          </Tag>
        ) : (
          <Tag color="cyan" type="light">
            未出库
          </Tag>
        ),
    },
    {
      title: "错误信息",
      width: 200,
      render: (_: unknown, a: Account) => {
        const parts = [
          a.plus_status === "激活失败" ? a.plus_last_message : "",
          a.last_refresh_error,
          a.last_token_refresh_error,
        ].filter(Boolean);
        const msg = parts.join("；");
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
      title: "国家",
      dataIndex: "country",
      width: 70,
      render: (v: string | null) =>
        v ? <Tag color="blue" type="light">{v}</Tag> : <Text type="tertiary" size="small">-</Text>,
    },
    {
      title: "出口IP",
      dataIndex: "exit_ip",
      width: 140,
      render: (v: string | null, a: Account) => (
        <Text
          type="tertiary"
          size="small"
          ellipsis={{ showTooltip: true }}
          style={{ maxWidth: 130 }}
          title={a.proxy || ""}
        >
          {v || "-"}
        </Text>
      ),
    },
    {
      title: "注册日期",
      dataIndex: "created_at",
      width: 140,
      render: (v: string | null) => <Text type="tertiary" size="small">{formatDateTime(v)}</Text>,
    },
    {
      title: "激活日期",
      dataIndex: "plus_activated_at",
      width: 140,
      render: (v: string | null) => <Text type="tertiary" size="small">{v ? formatDateTime(v) : "-"}</Text>,
    },
    {
      title: "更新时间",
      dataIndex: "last_token_refresh_at",
      width: 140,
      render: (v: string | null) => <Text type="tertiary" size="small">{formatDateTime(v)}</Text>,
    },
    {
      title: "操作",
      width: 170,
      fixed: "right",
      render: (_: unknown, a: Account) => {
        return (
          <Space spacing={2}>
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
              title="校验/刷新"
              loading={refreshing.has(a.access_token)}
              onClick={() => void handleRefresh([a.access_token])}
            />
            {a.plus_unavailable ? (
              <Popconfirm
                title="标记该账号激活可用？"
                content="将清除不可用标记并重置激活态（未激活），使其重新进入下一轮激活。"
                onConfirm={() => void handleMarkPlusAvailable([a.access_token], true)}
              >
                <Button
                  size="small"
                  theme="borderless"
                  type="secondary"
                  title="标记激活可用"
                  icon={<IconTickCircle />}
                />
              </Popconfirm>
            ) : null}
            <Button
              size="small"
              theme="borderless"
              icon={<IconEdit />}
              title="编辑状态/代理"
              onClick={() => openEdit(a)}
            />
            <Popconfirm title="删除该账号？" onConfirm={() => void handleDelete([a.access_token])}>
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} title="删除" />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const allOnPageSelected = accounts.length > 0 && accounts.every((a) => selectedKeys.includes(a.access_token));
  const toggleSelectAll = () =>
    setSelectedKeys(allOnPageSelected ? [] : accounts.map((a) => a.access_token));
  const toggleOne = (token: string) =>
    setSelectedKeys((prev) => (prev.includes(token) ? prev.filter((t) => t !== token) : [...prev, token]));

  const metricCards = [
    { label: "账户总数", value: summary.total },
    { label: "存活", value: summary.alive, color: "var(--semi-color-success)" },
    { label: "失效", value: summary.dead, color: "var(--semi-color-danger)" },
    { label: "已激活", value: summary.activated, color: "var(--semi-color-success)" },
    ...(summary.needs_review
      ? [{ label: "需核查", value: summary.needs_review, color: "var(--semi-color-warning)" }]
      : []),
    { label: "未出库", value: summary.unused, color: "var(--semi-color-primary)" },
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
        placeholder="搜索邮箱 / 密码 / CDK / Token"
        style={{ width: isMobile ? "100%" : 240 }}
      />
      <Select
        value={statusFilter}
        onChange={(v) => {
          setStatusFilter((v as "" | "valid" | "dead" | "unavailable") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={[
          { label: "全部状态", value: "" },
          { label: "有效", value: "valid" },
          { label: "失效", value: "dead" },
          { label: "不可用", value: "unavailable" },
        ]}
      />
      <Select
        value={planFilter}
        onChange={(v) => {
          setPlanFilter((v as "" | "free" | "plus") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={[
          { label: "全部套餐", value: "" },
          { label: "Free", value: "free" },
          { label: "Plus", value: "plus" },
        ]}
      />
      <Select
        value={activationFilter}
        onChange={(v) => {
          setActivationFilter((v as "" | "activated" | "pending" | "activating" | "failed" | "review") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={[
          { label: "全部激活", value: "" },
          { label: "待激活", value: "pending" },
          { label: "已激活", value: "activated" },
          { label: "激活中", value: "activating" },
          { label: "激活失败", value: "failed" },
          { label: "需核查", value: "review" },
        ]}
      />
      <Select
        value={usedFilter}
        onChange={(v) => {
          setUsedFilter((v as "" | "used" | "unused") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 130 }}
        optionList={[
          { label: "全部出库", value: "" },
          { label: "已出库", value: "used" },
          { label: "未出库", value: "unused" },
        ]}
      />
    </>
  );
  const activeFilterCount =
    (query.trim() ? 1 : 0) + (statusFilter ? 1 : 0) + (planFilter ? 1 : 0) + (activationFilter ? 1 : 0) + (usedFilter ? 1 : 0);

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Title heading={isMobile ? 4 : 3} style={{ margin: 0 }}>
          账号管理
        </Title>
      </div>

      <StatCards mobile={isMobile} items={metricCards} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16, alignItems: "center", justifyContent: "space-between" }}>
        {isMobile ? (
          <div style={{ width: "100%" }}>
            <MobileFilters activeCount={activeFilterCount}>{filterControls}</MobileFilters>
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>{filterControls}</div>
        )}

        {/* 列表操作：刷新 / 同步(导入·导出，同一份迁移 JSON)；选中时可删除 */}
        <Space wrap>
          {selectedKeys.length > 0 ? (
            <>
              <Text type="tertiary">已选 {selectedKeys.length}</Text>
              <Popconfirm title={`删除选中的 ${selectedKeys.length} 个账号？`} onConfirm={() => void handleDelete(selectedKeys)}>
                <Button size="small" type="danger" icon={<IconDelete />}>
                  删除选中
                </Button>
              </Popconfirm>
              <Popconfirm
                title={`标记选中的 ${selectedKeys.length} 个账号激活可用？`}
                content="将清除不可用标记并重置激活态（未激活），使其重新进入下一轮激活。"
                onConfirm={() => void handleMarkPlusAvailable(selectedKeys, true)}
              >
                <Button size="small" theme="light" type="secondary" loading={busy}>
                  标记可用
                </Button>
              </Popconfirm>
              <Popconfirm
                title={`⚠️ 撤销选中的 ${selectedKeys.length} 个账号的激活状态？`}
                content="危险操作：把激活状态整体复位为「未激活」（清空激活记录与 CDK 绑定，不改动真实套餐）。仅在程序异常错误标记了激活状态时使用，请确认后再操作。"
                okType="danger"
                okText="确认撤销"
                onConfirm={() => void handleRevokeActivation(selectedKeys)}
              >
                <Button size="small" type="danger" theme="light" loading={busy}>
                  撤销激活
                </Button>
              </Popconfirm>
              <span style={{ width: 1, height: 18, background: "var(--semi-color-border)", display: "inline-block" }} />
            </>
          ) : null}
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          {/* 同步：迁移 JSON（完整字段）与账号池文本（邮箱---密码---2FA--Accesstoken）两套格式。 */}
          <Dropdown
            trigger="click"
            render={
              <Dropdown.Menu>
                <Dropdown.Item icon={<IconUpload />} onClick={() => setImportOpen(true)}>
                  导入
                </Dropdown.Item>
                <Dropdown.Item icon={<IconDownload />} onClick={() => void handleExportPool()}>
                  导出账号（邮箱格式）{selectedKeys.length ? `（选中 ${selectedKeys.length}）` : "（全部）"}
                </Dropdown.Item>
                <Dropdown.Item icon={<IconDownload />} onClick={() => void handleExportMigration()}>
                  导出迁移 JSON{selectedKeys.length ? `（选中 ${selectedKeys.length}）` : "（全部）"}
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
          onToggleAll={toggleSelectAll}
          onToggle={toggleOne}
          onRefresh={(t) => void handleRefresh([t])}
          onEdit={openEdit}
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
          rowKey="access_token"
          tableLayout="fixed"
          scroll={{ x: 1680 }}
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
          empty="暂无账号，先导入入库，或用右上角注册机注册。"
        />
      )}

      {/* 编辑弹窗 */}
      <Modal
        title="编辑账户"
        visible={!!editTarget}
        onCancel={() => setEditTarget(null)}
        onOk={() => void handleSaveEdit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        maskClosable={false}
        fullScreen={isMobile}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 8 }}>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>状态</Text>
            <Select
              value={editStatus}
              onChange={(v) => setEditStatus(v as AccountStatus)}
              style={{ width: "100%" }}
              optionList={[
                { label: "正常", value: "正常" },
                { label: "限流", value: "限流" },
                { label: "异常", value: "异常" },
                { label: "禁用", value: "禁用" },
              ]}
            />
          </div>
          <div>
            <Text style={{ display: "block", marginBottom: 6 }}>账号代理</Text>
            <Input value={editProxy} onChange={setEditProxy} placeholder="留空走全局代理" />
            {(editTarget?.country || editTarget?.exit_ip) && (
              <Text type="tertiary" size="small" style={{ display: "block", marginTop: 6 }}>
                地区 {editTarget?.country || "-"} · 注册时出口 IP {editTarget?.exit_ip || "-"}
              </Text>
            )}
          </div>
        </div>
      </Modal>

      {/* 导入弹窗：选择「导出」下载的迁移 JSON 文件导入（也可直接粘贴内容）。 */}
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
          支持三种格式：迁移 JSON（含完整字段）、账号池文本每行 `邮箱---密码---2FA--Accesstoken`、或每行一个 access_token。
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
        {/* 点击选择 + 拖拽上传：拖入迁移 JSON 文件即读取内容。 */}
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
            <Text>点击选择文件，或将迁移 JSON 文件拖拽到此处</Text>
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
          placeholder={"选择文件后内容显示在此，或直接粘贴迁移 JSON / access_token（每行一个）..."}
        />
      </Modal>
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
  onToggleAll: () => void;
  onToggle: (token: string) => void;
  onRefresh: (token: string) => void;
  onEdit: (a: Account) => void;
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
  onToggleAll,
  onToggle,
  onRefresh,
  onEdit,
  onDelete,
  page,
  pageSize,
  total,
  onPageChange,
}: AccountMobileListProps) {
  if (!loading && accounts.length === 0) {
    return (
      <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
        <Text type="tertiary">暂无账号，先导入入库，或用注册机注册。</Text>
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
          const checked = selected.includes(a.access_token);
          const token = a.access_token || "";
          const status = accountStatusInfo(a, refreshing.has(a.access_token));
          return (
            <Card
              key={a.access_token}
              bodyStyle={{ padding: 14 }}
              style={{ borderColor: checked ? "var(--semi-color-primary)" : undefined }}
            >
              {/* 顶行：勾选 + 邮箱 + 状态 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <Checkbox checked={checked} onChange={() => onToggle(a.access_token)} />
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
                <Space spacing={4}>
                  {status.spin ? <Spin size="small" /> : null}
                  <Tag color={status.color as never} type="light">
                    {status.text}
                  </Tag>
                </Space>
              </div>

              {/* 标签行：套餐 / 出库 / 国家（可用性已并入顶行状态） */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {tierTag(a.type)}
                {a.used ? (
                  <Tag color="grey" type="light">已出库</Tag>
                ) : (
                  <Tag color="cyan" type="light">未出库</Tag>
                )}
                {a.country ? <Tag color="blue" type="light">{a.country}</Tag> : null}
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

              {/* 操作行 */}
              <div style={{ display: "flex", gap: 4, marginTop: 12, justifyContent: "space-between" }}>
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
                  title="校验/刷新"
                  loading={refreshing.has(a.access_token)}
                  onClick={() => onRefresh(a.access_token)}
                />
                <Button size="small" theme="borderless" icon={<IconEdit />} title="编辑" onClick={() => onEdit(a)} />
                <Popconfirm title="删除该账号？" onConfirm={() => onDelete(a.access_token)}>
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
