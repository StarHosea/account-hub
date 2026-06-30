import { useEffect, useState } from "react";
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
} from "@douyinfe/semi-ui-19";
import {
  IconRefresh,
  IconDownload,
  IconUpload,
  IconShield,
  IconDelete,
  IconEdit,
  IconMail,
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
  enable2FA,
  disable2FA,
  fetch2FAProgress,
  exportCredentials,
  markAccountsUsed,
  type Account,
  type AccountStatus,
  type AccountSummary,
  type AccountListParams,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { log, useLogStore } from "@/store/logs";
import RegisterControl from "@/components/RegisterControl";

const { Title, Text } = Typography;

type TwoFAAction = "enable" | "disable";

const PAGE_SIZE = 10;
const EMPTY_SUMMARY: AccountSummary = { total: 0, alive: 0, dead: 0, activated: 0, unused: 0 };

function copy(text: string, label: string) {
  void navigator.clipboard.writeText(text);
  Toast.success(`${label}已复制`);
}

function maskSecret(s: string) {
  return s.length > 10 ? `${s.slice(0, 4)}····${s.slice(-4)}` : s;
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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<AccountSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [twofaPending, setTwofaPending] = useState<Record<string, TwoFAAction>>({});
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // 搜索 / 筛选
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [statusFilter, setStatusFilter] = useState<"" | "alive" | "dead">("");
  const [plusFilter, setPlusFilter] = useState<"" | "activated" | "inactive">("");
  const [usedFilter, setUsedFilter] = useState<"" | "used" | "unused">("");

  const [editTarget, setEditTarget] = useState<Account | null>(null);
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editProxy, setEditProxy] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const openLog = useLogStore((s) => s.setOpen);
  // 按 token 反查邮箱，作为日志 scope，定位到具体账号。
  const emailOf = (token: string) => accounts.find((a) => a.access_token === token)?.email ?? `${token.slice(0, 8)}…`;

  const buildParams = (overrides?: Partial<AccountListParams>): AccountListParams => ({
    q: debouncedQuery.trim() || undefined,
    status: statusFilter || undefined,
    plus: plusFilter || undefined,
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
  }, [debouncedQuery, statusFilter, plusFilter, usedFilter, page]);

  const setRefreshFlag = (token: string, on: boolean) =>
    setRefreshing((prev) => {
      const next = new Set(prev);
      if (on) next.add(token);
      else next.delete(token);
      return next;
    });

  const setTwofaFlag = (token: string, action: TwoFAAction | null) =>
    setTwofaPending((prev) => {
      const next = { ...prev };
      if (action) next[token] = action;
      else delete next[token];
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

  const poll2FA = (id: string, scope: string) =>
    new Promise<Awaited<ReturnType<typeof fetch2FAProgress>>>((resolve, reject) => {
      let lastMsg = "";
      const timer = setInterval(async () => {
        try {
          const p = await fetch2FAProgress(id);
          // 中间步骤实时入日志，去重连续相同消息。
          if (p.message && p.message !== lastMsg) {
            lastMsg = p.message;
            if (!p.done) log.info(scope, p.message);
          }
          if (p.done) {
            clearInterval(timer);
            resolve(p);
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
        }
      }, 800);
    });

  const handle2FA = async (token: string, action: TwoFAAction) => {
    const label = action === "enable" ? "开启2FA" : "关闭2FA";
    const scope = `${label} · ${emailOf(token)}`;
    setTwofaFlag(token, action);
    log.info(scope, "开始");
    try {
      const { progress_id } = action === "enable" ? await enable2FA(token) : await disable2FA(token);
      const res = await poll2FA(progress_id, scope);
      if (!res.ok) {
        // 后端 message 已是完整人话（含失败原因/代理连不上等），优先展示；缺失再退回错误码。
        // 后端 message 常以「失败：」开头，去掉以免和这里的前缀重复成「失败：失败：」。
        const detail = res.message?.trim().replace(/^失败：?/, "") || res.error || "未知错误";
        log.error(scope, detail);
        openLog(true);
        Toast.error({ content: `${label}失败：${detail}`, duration: 6 });
        return;
      }
      log.success(scope, res.message?.trim() || "成功");
      await load(true);
      Toast.success(action === "enable" ? "已开启 2FA" : "已关闭 2FA");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "操作失败";
      log.error(scope, msg);
      openLog(true);
      Toast.error(msg);
    } finally {
      setTwofaFlag(token, null);
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

  const handleExport = async (opts: { onlyUnused?: boolean; markUsed?: boolean; selected?: boolean }) => {
    const tokens = opts.selected ? selectedKeys : [];
    if (opts.selected && !tokens.length) {
      Toast.warning("请先选择账号");
      return;
    }
    setBusy(true);
    try {
      const text = await exportCredentials(tokens, { onlyUnused: opts.onlyUnused, markUsed: opts.markUsed });
      if (!text.trim()) {
        Toast.warning("没有可导出的账号");
        return;
      }
      downloadText(text, `accounts-${Date.now()}.txt`);
      Toast.success("已导出账号信息");
      if (opts.markUsed) void load(true);
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
    const tokens = importText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!tokens.length) {
      Toast.warning("请粘贴要导入的 access_token");
      return;
    }
    setBusy(true);
    try {
      const data = await createAccounts(tokens);
      setImportOpen(false);
      setImportText("");
      await load(true);
      Toast.success(`导入完成，新增 ${data.added ?? 0} 个`);
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
      width: 90,
      render: (_: unknown, a: Account) => {
        const tk = a.access_token || "";
        return (
          <Space spacing={4}>
            <Text type="tertiary" style={{ fontFamily: "monospace", fontSize: 12 }}>
              ····{tk.slice(-5)}
            </Text>
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(tk, "accessToken")} />
          </Space>
        );
      },
    },
    {
      title: "档位",
      width: 90,
      render: (_: unknown, a: Account) => {
        const t = String(a.type ?? "").trim();
        const k = t.toLowerCase();
        // 真实订阅档位（OpenAI 返回的 type），与下方「状态」的激活流程区分开。
        let color = "grey";
        let label = t || "未知";
        if (k === "plus") [color, label] = ["amber", "Plus"];
        else if (k === "pro") [color, label] = ["violet", "Pro"];
        else if (k === "team" || k === "enterprise") [color, label] = ["blue", t];
        else if (k === "free") [color, label] = ["grey", "Free"];
        return (
          <Tag color={color as never} type="light">
            {label}
          </Tag>
        );
      },
    },
    {
      title: "状态",
      width: 130,
      render: (_: unknown, a: Account) => {
        const pending = twofaPending[a.access_token];
        const isRefreshing = refreshing.has(a.access_token);
        // 档位列已单独展示 Plus/Free，这里只表示账号本身是否有效（有效/失效）。
        let text = "有效";
        let color: string = "green";
        let spin = false;
        if (pending === "enable") [text, color, spin] = ["设置 2FA 中", "blue", true];
        else if (pending === "disable") [text, color, spin] = ["关闭 2FA 中", "blue", true];
        else if (isRefreshing) [text, color, spin] = ["校验中", "blue", true];
        else if (a.status === "异常" || a.status === "禁用") [text, color] = ["失效", "red"];
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
      width: 170,
      render: (pwd: string | null) =>
        pwd ? (
          <Space>
            <Text style={{ fontFamily: "monospace", fontSize: 12 }}>{pwd}</Text>
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => copy(pwd, "密码")} />
          </Space>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "2FA",
      width: 160,
      render: (_: unknown, a: Account) =>
        a.totp_secret ? (
          <Space spacing={4}>
            <Tag color="violet" type="light">
              {maskSecret(a.totp_secret)}
            </Tag>
            <Button
              size="small"
              theme="borderless"
              icon={<IconCopy />}
              onClick={() => copy(a.otpauth_url || a.totp_secret || "", "2FA 密钥")}
            />
          </Space>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "出库状态",
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
      title: "创建时间",
      dataIndex: "created_at",
      width: 140,
      render: (v: string | null) => <Text type="tertiary" size="small">{formatDateTime(v)}</Text>,
    },
    {
      title: "操作",
      width: 170,
      fixed: "right",
      render: (_: unknown, a: Account) => {
        const pending = !!twofaPending[a.access_token];
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
            {a.totp_secret ? (
              <Button
                size="small"
                theme="borderless"
                type="warning"
                title="关闭 2FA"
                loading={pending}
                icon={<IconShield />}
                onClick={() => void handle2FA(a.access_token, "disable")}
              />
            ) : (
              <Button
                size="small"
                theme="borderless"
                type="tertiary"
                title="开启 2FA"
                loading={pending}
                icon={<IconShield />}
                onClick={() => void handle2FA(a.access_token, "enable")}
              />
            )}
            <Popconfirm title="删除该账号？" onConfirm={() => void handleDelete([a.access_token])}>
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} title="删除" />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const metricCards = [
    { label: "账户总数", value: summary.total },
    { label: "存活", value: summary.alive, color: "var(--semi-color-success)" },
    { label: "失效", value: summary.dead, color: "var(--semi-color-danger)" },
    { label: "已激活", value: summary.activated, color: "var(--semi-color-success)" },
    { label: "未出库", value: summary.unused, color: "var(--semi-color-primary)" },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <Title heading={3} style={{ margin: 0 }}>
          号池管理
        </Title>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<IconUpload />} onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Dropdown
            trigger="click"
            render={
              <Dropdown.Menu>
                <Dropdown.Item onClick={() => void handleExport({})}>导出全部</Dropdown.Item>
                <Dropdown.Item onClick={() => void handleExport({ onlyUnused: true })}>仅导出未出库</Dropdown.Item>
                <Dropdown.Item onClick={() => void handleExport({ onlyUnused: true, markUsed: true })}>
                  导出未出库并标记已出库
                </Dropdown.Item>
                <Dropdown.Item onClick={() => void handleExport({ selected: true })}>导出选中</Dropdown.Item>
              </Dropdown.Menu>
            }
          >
            <Button icon={<IconDownload />} theme="solid" type="primary">
              导出账号信息
            </Button>
          </Dropdown>
        </Space>
      </div>

      <RegisterControl />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        {metricCards.map((m) => (
          <Card key={m.label} style={{ borderRadius: 12 }} bodyStyle={{ padding: 16 }}>
            <Text type="tertiary" size="small">
              {m.label}
            </Text>
            <div style={{ fontSize: 26, fontWeight: 600, color: m.color, marginTop: 4 }}>{m.value}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <Input
          prefix={<IconSearch />}
          value={query}
          onChange={(v) => {
            setQuery(v);
            setPage(1);
          }}
          showClear
          placeholder="搜索邮箱 / 密码"
          style={{ width: 240 }}
        />
        <Select
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter((v as "" | "alive" | "dead") ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部状态", value: "" },
            { label: "存活", value: "alive" },
            { label: "失效", value: "dead" },
          ]}
        />
        <Select
          value={plusFilter}
          onChange={(v) => {
            setPlusFilter((v as "" | "activated" | "inactive") ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部激活", value: "" },
            { label: "已激活", value: "activated" },
            { label: "未激活", value: "inactive" },
          ]}
        />
        <Select
          value={usedFilter}
          onChange={(v) => {
            setUsedFilter((v as "" | "used" | "unused") ?? "");
            setPage(1);
          }}
          style={{ width: 130 }}
          optionList={[
            { label: "全部出库", value: "" },
            { label: "已出库", value: "used" },
            { label: "未出库", value: "unused" },
          ]}
        />
      </div>

      {selectedKeys.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Text type="tertiary">已选 {selectedKeys.length} 项</Text>
            <Button size="small" icon={<IconTickCircle />} onClick={() => void handleMarkUsed(selectedKeys, true)} loading={busy}>
              标记已出库
            </Button>
            <Button size="small" onClick={() => void handleMarkUsed(selectedKeys, false)} loading={busy}>
              标记未出库
            </Button>
            <Popconfirm title={`删除选中的 ${selectedKeys.length} 个账号？`} onConfirm={() => void handleDelete(selectedKeys)}>
              <Button size="small" type="danger" icon={<IconDelete />}>
                删除选中
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}

      <Table
        columns={columns}
        dataSource={accounts}
        loading={loading}
        rowKey="access_token"
        tableLayout="fixed"
        scroll={{ x: 1160 }}
        pagination={{
          currentPage: page,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: setPage,
        }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys((keys ?? []) as string[]),
        }}
        empty="暂无账号，先导入或在工作台一键注册。"
      />

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
          </div>
        </div>
      </Modal>

      {/* 导入弹窗 */}
      <Modal
        title="导入账号 Token"
        visible={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText="导入"
        confirmLoading={busy}
      >
        <Text type="tertiary">一行一个 access_token。</Text>
        <TextArea
          value={importText}
          onChange={(v) => setImportText(v)}
          rows={10}
          style={{ marginTop: 8, fontFamily: "monospace" }}
          placeholder={"粘贴 access_token，每行一个..."}
        />
      </Modal>
    </div>
  );
}
