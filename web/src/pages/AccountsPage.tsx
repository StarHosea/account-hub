import { useEffect, useMemo, useRef, useState } from "react";
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
  IconMail,
  IconKey,
  IconCopy,
  IconSearch,
  IconClose,
} from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  fetchAccounts,
  refreshAccounts,
  fetchRefreshProgress,
  deleteAccounts,
  createAccounts,
  exportAccounts,
  markAccountsUsed,
  revokeActivation,
  type Account,
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
  plus_review: "red",
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

export default function AccountsPage({ planType }: { planType: AccountPlanPage }) {
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
  const [stageFilter, setStageFilter] = useState<"" | AccountStage>("");
  const [dispatchedFilter, setDispatchedFilter] = useState<"" | "dispatched" | "undispatched">("");

  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"selected" | "filtered">("selected");
  const [exportMarkDispatched, setExportMarkDispatched] = useState(false);

  const [revokeActivationOpen, setRevokeActivationOpen] = useState(false);
  const [revokeActivationTokens, setRevokeActivationTokens] = useState<string[]>([]);
  const [revokeActivationRevokeCdk, setRevokeActivationRevokeCdk] = useState(true);

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
        Toast.success("刷新完成");
      }
      await load(true);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "刷新失败");
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

  const openRevokeActivationModal = (tokens: string[]) => {
    if (!tokens.length) {
      Toast.warning("请先选择账号");
      return;
    }
    setRevokeActivationTokens(tokens);
    setRevokeActivationRevokeCdk(true);
    setRevokeActivationOpen(true);
  };

  const handleRevokeActivation = async () => {
    if (!revokeActivationTokens.length) return;
    setBusy(true);
    try {
      const data = await revokeActivation(revokeActivationTokens, revokeActivationRevokeCdk);
      setRevokeActivationOpen(false);
      setRevokeActivationTokens([]);
      await load(true);
      if (data.updated) {
        const cdkPart = revokeActivationRevokeCdk && data.cdk_revoked ? `，已撤销 ${data.cdk_revoked} 个 CDK` : "";
        Toast.success(`已撤销 ${data.updated} 个账号的激活状态${cdkPart}`);
      } else if (data.skipped) {
        Toast.info("所选账号均非「需核查」状态，未做变更");
      } else {
        Toast.info("没有需要变更的账号");
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "撤销失败");
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
        tokens = data.items.map((a) => a.access_token);
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
      tokens = accounts.map((a) => a.access_token);
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
      render: (_: unknown, a: Account) => stageTag(a, refreshing.has(a.access_token)),
    },
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
            {planType === "plus" && a.stage === "plus_review" ? (
              <Button
                size="small"
                theme="borderless"
                type="warning"
                title="撤销激活"
                icon={<IconClose />}
                onClick={() => openRevokeActivationModal([a.access_token])}
              />
            ) : null}
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

  const metricCards =
    planType === "free"
      ? [
          { label: "总数", value: summary.total },
          { label: "已注册", value: summary.registered ?? 0, color: "var(--semi-color-success)" },
          { label: "激活中", value: summary.activating ?? 0, color: "var(--semi-color-warning)" },
        ]
      : [
          { label: "总数", value: summary.total },
          { label: "未出库", value: summary.undispatched ?? 0, color: "var(--semi-color-primary)" },
          { label: "激活中", value: summary.activating ?? 0, color: "var(--semi-color-warning)" },
          { label: "已激活", value: summary.plus_activated ?? 0, color: "var(--semi-color-success)" },
          { label: "需核查", value: summary.plus_review ?? 0, color: "var(--semi-color-danger)" },
        ];

  const stageOptions =
    planType === "free"
      ? [
          { label: "全部状态", value: "" },
          { label: "已注册", value: "registered" },
          { label: "激活中", value: "activating" },
        ]
      : [
          { label: "全部状态", value: "" },
          { label: "激活中", value: "activating" },
          { label: "已激活", value: "plus_activated" },
          { label: "需核查", value: "plus_review" },
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
                <Button
                  size="small"
                  type="warning"
                  theme="light"
                  loading={busy}
                  onClick={() => openRevokeActivationModal(selectedKeys)}
                >
                  撤销激活
                </Button>
              ) : null}
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
          onToggleAll={toggleSelectAll}
          onToggle={toggleOne}
          onRefresh={(t) => void handleRefresh([t])}
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

      <Modal
        title="撤销激活"
        visible={revokeActivationOpen}
        onCancel={() => {
          setRevokeActivationOpen(false);
          setRevokeActivationTokens([]);
        }}
        onOk={() => void handleRevokeActivation()}
        okText="确认撤销"
        confirmLoading={busy}
        maskClosable={false}
        fullScreen={isMobile}
      >
        <Text>
          将把选中的 {revokeActivationTokens.length} 个「需核查」账号复位为免费已注册态，重新进入激活队列。
        </Text>
        <div style={{ marginTop: 16 }}>
          <Checkbox checked={revokeActivationRevokeCdk} onChange={(e) => setRevokeActivationRevokeCdk(!!e.target?.checked)}>
            同时撤销 CDK 使用状态（将 CDK 标记为可用）
          </Checkbox>
        </div>
        {!revokeActivationRevokeCdk ? (
          <Text type="tertiary" size="small" style={{ display: "block", marginTop: 8 }}>
            不撤销时仅复位账号，已消耗的 CDK 保持已使用状态。
          </Text>
        ) : null}
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
          const checked = selected.includes(a.access_token);
          const token = a.access_token || "";
          const statusNode = stageTag(a, refreshing.has(a.access_token));
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
                {statusNode}
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
