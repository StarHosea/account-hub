import { useEffect, useMemo, useState } from "react";
import {
  Table,
  Card,
  Button,
  Tag,
  Toast,
  Modal,
  Select,
  TextArea,
  Typography,
  Dropdown,
  Popconfirm,
  Space,
  Input,
  Checkbox,
  Pagination,
} from "@douyinfe/semi-ui-19";
import {
  IconRefresh,
  IconUpload,
  IconDownload,
  IconDelete,
  IconCopy,
  IconSearch,
  IconPlus,
  IconTick,
  IconClose,
  IconExternalOpen,
} from "@douyinfe/semi-icons";
import type { ColumnProps } from "@douyinfe/semi-ui-19/lib/es/table";

import {
  fetchPhones,
  importPhones,
  deletePhones,
  setPhonesUsed,
  addPhoneUsage,
  fetchPhonesExportText,
  type Phone,
  type PhoneCounts,
  type PhoneListParams,
  PHONE_MAX_USES,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useIsMobile } from "@/lib/use-is-mobile";
import { StatCards } from "@/components/StatCards";
import { MobileFilters } from "@/components/MobileFilters";

const { Title, Text } = Typography;

const PAGE_SIZE = 10;

const EMPTY_COUNTS: PhoneCounts = { total: 0, available: 0, cooldown: 0, used: 0, invalid: 0, total_uses: 0 };

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    Toast.success(`${label}已复制`);
  } catch {
    Toast.error("复制失败，请检查浏览器剪贴板权限");
  }
}

function fmtTime(v: string | null) {
  return v ? new Date(v).toLocaleString() : "—";
}

/** 冷却剩余的人类可读文案，如「冷却 42 分」；已结束返回空。 */
function cooldownLeft(until: string | null): string {
  if (!until) return "";
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return "";
  const mins = Math.ceil(ms / 60000);
  return mins >= 60 ? `冷却 ${Math.floor(mins / 60)} 时 ${mins % 60} 分` : `冷却 ${mins} 分`;
}

/** 计算手机号展示状态（与发号选号口径一致）。 */
function phoneStatus(p: Phone): { text: string; color: string } {
  if (p.invalid) return { text: "无效", color: "red" };
  if (p.used) return { text: "已使用", color: "grey" };
  const cd = cooldownLeft(p.cooldown_until);
  if (cd) return { text: cd, color: "amber" };
  return { text: "可用", color: "green" };
}

export default function PhonesPage() {
  const isMobile = useIsMobile();

  const [phones, setPhones] = useState<Phone[]>([]);
  const [counts, setCounts] = useState<PhoneCounts>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [usedFilter, setUsedFilter] = useState<"" | "0" | "1">("");

  const buildParams = (overrides?: Partial<PhoneListParams>): PhoneListParams => ({
    q: debouncedQuery.trim() || undefined,
    used: usedFilter || undefined,
    page,
    page_size: PAGE_SIZE,
    ...overrides,
  });

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchPhones(buildParams());
      setPhones(data.items);
      setCounts(data.counts);
      setTotal(data.total);
      setSelected((prev) => prev.filter((id) => data.items.some((p) => p.phone === id)));
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "加载手机号失败");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, usedFilter, page]);

  const selectedRows = useMemo(
    () => phones.filter((p) => selected.includes(p.phone)),
    [phones, selected],
  );

  const handleImport = async () => {
    if (!importText.trim()) {
      Toast.warning("请粘贴手机号");
      return;
    }
    setBusy(true);
    try {
      const data = await importPhones(importText);
      setImportText("");
      setImportOpen(false);
      await load(true);
      Toast.success(`导入完成，新增 ${data.result.added} 个，更新 ${data.result.updated} 个`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (items: string[]) => {
    if (!items.length) return;
    setBusy(true);
    try {
      const data = await deletePhones(items);
      await load(true);
      Toast.success(`删除 ${data.removed} 个`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSetUsed = async (items: string[], used: boolean) => {
    if (!items.length) return;
    setBusy(true);
    try {
      await setPhonesUsed(items, used);
      await load(true);
      Toast.success(used ? "已标记为已使用" : "已标记为未使用");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const handleAddUsage = async (items: string[]) => {
    if (!items.length) return;
    setBusy(true);
    try {
      await addPhoneUsage(items, 1);
      await load(true);
      Toast.success("使用次数 +1");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  // 导出到剪贴板：从服务端取全量/未使用文本。
  const exportToClipboard = async (onlyUnused: boolean) => {
    try {
      const text = await fetchPhonesExportText(onlyUnused);
      if (!text.trim()) {
        Toast.warning("没有可导出的手机号");
        return;
      }
      await copy(text, `${text.split("\n").length} 个手机号`);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "导出失败");
    }
  };

  // 导出选中：直接用内存中的行拼装，无需再请求。
  const exportSelectedToClipboard = async () => {
    if (!selectedRows.length) return;
    const text = selectedRows
      .map((p) => (p.fetch_url ? `${p.phone}----${p.fetch_url}` : p.phone))
      .join("\n");
    await copy(text, `${selectedRows.length} 个手机号`);
  };

  const allOnPageSelected = phones.length > 0 && phones.every((p) => selected.includes(p.phone));
  const toggleSelectAll = () =>
    setSelected(allOnPageSelected ? [] : phones.map((p) => p.phone));
  const toggleOne = (phone: string) =>
    setSelected((prev) => (prev.includes(phone) ? prev.filter((p) => p !== phone) : [...prev, phone]));

  const cards = [
    { label: "手机号总数", value: counts.total },
    { label: "可用", value: counts.available, color: "var(--semi-color-success)" },
    { label: "冷却中", value: counts.cooldown, color: "var(--semi-color-warning)" },
    { label: "已使用", value: counts.used, color: "var(--semi-color-tertiary)" },
    { label: "无效", value: counts.invalid, color: "var(--semi-color-danger)" },
    { label: "累计次数", value: counts.total_uses },
  ];

  const columns: ColumnProps<Phone>[] = [
    {
      title: "手机号",
      dataIndex: "phone",
      width: 180,
      render: (phone: string) => (
        <Space>
          <Text style={{ fontFamily: "monospace" }}>{phone}</Text>
          <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => void copy(phone, "手机号")} />
        </Space>
      ),
    },
    {
      title: "接码地址",
      dataIndex: "fetch_url",
      width: 280,
      render: (url: string) =>
        url ? (
          <Space style={{ minWidth: 0 }}>
            <Text ellipsis={{ showTooltip: true }} style={{ maxWidth: 200, fontSize: 12 }}>
              {url}
            </Text>
            <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => void copy(url, "接码地址")} />
            <Button
              size="small"
              theme="borderless"
              icon={<IconExternalOpen />}
              onClick={() => window.open(url, "_blank", "noopener")}
            />
          </Space>
        ) : (
          <Text type="tertiary">—</Text>
        ),
    },
    {
      title: "状态",
      width: 110,
      render: (_: unknown, p: Phone) => {
        const s = phoneStatus(p);
        return (
          <Tag color={s.color as never} type="light">
            {s.text}
          </Tag>
        );
      },
    },
    {
      title: "使用次数",
      dataIndex: "used_count",
      width: 90,
      render: (n: number) => (
        <Text strong>
          {n}
          <Text type="tertiary" size="small">
            /{PHONE_MAX_USES}
          </Text>
        </Text>
      ),
    },
    {
      title: "最近使用",
      dataIndex: "last_used_at",
      width: 160,
      render: (v: string | null) => (
        <Text type="tertiary" size="small">
          {fmtTime(v)}
        </Text>
      ),
    },
    {
      title: "导入时间",
      dataIndex: "imported_at",
      width: 160,
      render: (v: string | null) => (
        <Text type="tertiary" size="small">
          {fmtTime(v)}
        </Text>
      ),
    },
    {
      title: "操作",
      width: 150,
      fixed: "right",
      render: (_: unknown, p: Phone) => (
        <Space>
          <Button
            size="small"
            theme="borderless"
            icon={<IconPlus />}
            disabled={p.used}
            title={p.used ? "已使用，不能再加次数" : "使用次数 +1"}
            onClick={() => void handleAddUsage([p.phone])}
          >
            {p.used_count}/{PHONE_MAX_USES}
          </Button>
          <Button
            size="small"
            theme="borderless"
            icon={p.used ? <IconClose /> : <IconTick />}
            onClick={() => void handleSetUsed([p.phone], !p.used)}
          />
          <Popconfirm title="删除该手机号？" onConfirm={() => void handleDelete([p.phone])}>
            <Button size="small" theme="borderless" type="danger" icon={<IconDelete />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const exportMenu = (
    <Dropdown.Menu>
      <Dropdown.Item onClick={() => void exportToClipboard(false)}>全部到剪贴板</Dropdown.Item>
      <Dropdown.Item onClick={() => void exportToClipboard(true)}>仅未使用到剪贴板</Dropdown.Item>
      {selectedRows.length > 0 ? (
        <Dropdown.Item onClick={() => void exportSelectedToClipboard()}>
          选中 {selectedRows.length} 个到剪贴板
        </Dropdown.Item>
      ) : null}
    </Dropdown.Menu>
  );

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
        placeholder="搜索手机号 / 接码地址"
        style={{ width: isMobile ? "100%" : 240 }}
      />
      <Select
        value={usedFilter}
        onChange={(v) => {
          setUsedFilter((v as "" | "0" | "1") ?? "");
          setPage(1);
        }}
        style={{ width: isMobile ? "100%" : 140 }}
        optionList={[
          { label: "全部状态", value: "" },
          { label: "未使用", value: "0" },
          { label: "已使用", value: "1" },
        ]}
      />
    </>
  );
  const activeFilterCount = (query.trim() ? 1 : 0) + (usedFilter ? 1 : 0);

  return (
    <div>
      {/* 标题与主操作：手机端纵向堆叠，按钮占满更易点 */}
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
          手机号管理
        </Title>
        <Space spacing={8} style={{ flexWrap: "wrap" }}>
          <Button icon={<IconRefresh />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button icon={<IconUpload />} theme="solid" type="primary" onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Dropdown trigger="click" render={exportMenu}>
            <Button icon={<IconDownload />}>导出</Button>
          </Dropdown>
        </Space>
      </div>

      {/* 统计卡：手机端紧凑 */}
      <StatCards mobile={isMobile} items={cards} />

      {/* 筛选区：PC 平铺，手机端折叠进抽屉 */}
      {isMobile ? (
        <MobileFilters activeCount={activeFilterCount}>{filterControls}</MobileFilters>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>{filterControls}</div>
      )}

      {/* 批量操作条 */}
      {selected.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Space style={{ flexWrap: "wrap" }}>
            <Text type="tertiary">已选 {selected.length} 项</Text>
            <Button size="small" icon={<IconCopy />} onClick={() => void exportSelectedToClipboard()}>
              导出到剪贴板
            </Button>
            <Button size="small" icon={<IconPlus />} onClick={() => void handleAddUsage(selected)}>
              次数+1
            </Button>
            <Button size="small" icon={<IconTick />} onClick={() => void handleSetUsed(selected, true)}>
              标记已用
            </Button>
            <Button size="small" icon={<IconClose />} onClick={() => void handleSetUsed(selected, false)}>
              标记未用
            </Button>
            <Popconfirm title={`删除选中的 ${selected.length} 个？`} onConfirm={() => void handleDelete(selected)}>
              <Button size="small" type="danger" icon={<IconDelete />}>
                删除选中
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ) : null}

      {/* 内容区：手机端卡片流，PC 表格 */}
      {isMobile ? (
        <MobileList
          phones={phones}
          loading={loading}
          selected={selected}
          allSelected={allOnPageSelected}
          onToggleAll={toggleSelectAll}
          onToggle={toggleOne}
          onCopy={(t, l) => void copy(t, l)}
          onAddUsage={(phone) => void handleAddUsage([phone])}
          onSetUsed={(phone, used) => void handleSetUsed([phone], used)}
          onDelete={(phone) => void handleDelete([phone])}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      ) : (
        <Table
          columns={columns}
          dataSource={phones}
          loading={loading}
          rowKey="phone"
          tableLayout="fixed"
          scroll={{ x: 1000 }}
          pagination={{ currentPage: page, pageSize: PAGE_SIZE, total, onPageChange: setPage }}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected((keys ?? []) as string[]) }}
          empty="暂无手机号，先导入。"
        />
      )}

      {/* 导入弹窗 */}
      <Modal
        title="导入手机号"
        visible={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void handleImport()}
        okText="导入"
        confirmLoading={busy}
        fullScreen={isMobile}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 }}>
          <Text type="tertiary" size="small">
            每行一个，格式 <Text code>手机号----接码地址</Text>；无接码地址可只填手机号。重复手机号会自动去重。
          </Text>
          <TextArea
            value={importText}
            onChange={setImportText}
            rows={isMobile ? 12 : 10}
            style={{ fontFamily: "monospace" }}
            placeholder={"13800138000----https://example.com/sms/13800138000\n13900139000----https://example.com/sms/13900139000"}
          />
        </div>
      </Modal>
    </div>
  );
}

// ───────────────────────── 手机端卡片流 ─────────────────────────

type MobileListProps = {
  phones: Phone[];
  loading: boolean;
  selected: string[];
  allSelected: boolean;
  onToggleAll: () => void;
  onToggle: (phone: string) => void;
  onCopy: (text: string, label: string) => void;
  onAddUsage: (phone: string) => void;
  onSetUsed: (phone: string, used: boolean) => void;
  onDelete: (phone: string) => void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

function MobileList({
  phones,
  loading,
  selected,
  allSelected,
  onToggleAll,
  onToggle,
  onCopy,
  onAddUsage,
  onSetUsed,
  onDelete,
  page,
  pageSize,
  total,
  onPageChange,
}: MobileListProps) {
  if (!loading && phones.length === 0) {
    return (
      <Card bodyStyle={{ padding: 32, textAlign: "center" }}>
        <Text type="tertiary">暂无手机号，先导入。</Text>
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
        {phones.map((p) => {
          const checked = selected.includes(p.phone);
          return (
            <Card
              key={p.phone}
              bodyStyle={{ padding: 14 }}
              style={{ borderColor: checked ? "var(--semi-color-primary)" : undefined }}
            >
              {/* 顶行：勾选 + 手机号 + 状态标签 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Checkbox checked={checked} onChange={() => onToggle(p.phone)} />
                <Text
                  strong
                  style={{ fontFamily: "monospace", fontSize: 17, flex: 1 }}
                  onClick={() => onCopy(p.phone, "手机号")}
                >
                  {p.phone}
                </Text>
                <Tag color={phoneStatus(p).color as never} type="light">
                  {phoneStatus(p).text}
                </Tag>
              </div>

              {/* 接码地址 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, minWidth: 0 }}>
                <Text type="tertiary" size="small" style={{ flexShrink: 0 }}>
                  接码
                </Text>
                {p.fetch_url ? (
                  <>
                    <Text ellipsis={{ showTooltip: true }} style={{ flex: 1, fontSize: 12 }}>
                      {p.fetch_url}
                    </Text>
                    <Button size="small" theme="borderless" icon={<IconCopy />} onClick={() => onCopy(p.fetch_url, "接码地址")} />
                    <Button
                      size="small"
                      theme="borderless"
                      icon={<IconExternalOpen />}
                      onClick={() => window.open(p.fetch_url, "_blank", "noopener")}
                    />
                  </>
                ) : (
                  <Text type="tertiary">—</Text>
                )}
              </div>

              {/* 次数 + 最近使用 */}
              <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                <Text type="tertiary" size="small">
                  次数 <Text strong>{p.used_count}</Text>/{PHONE_MAX_USES}
                </Text>
                <Text type="tertiary" size="small">
                  最近 {fmtTime(p.last_used_at)}
                </Text>
              </div>

              {/* 操作行：大按钮拇指可点 */}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <Button
                  size="small"
                  icon={<IconPlus />}
                  style={{ flex: 1 }}
                  disabled={p.used}
                  onClick={() => onAddUsage(p.phone)}
                >
                  次数 {p.used_count}/{PHONE_MAX_USES}
                </Button>
                <Button
                  size="small"
                  icon={p.used ? <IconClose /> : <IconTick />}
                  style={{ flex: 1 }}
                  onClick={() => onSetUsed(p.phone, !p.used)}
                >
                  {p.used ? "标记未用" : "标记已用"}
                </Button>
                <Popconfirm title="删除该手机号？" onConfirm={() => onDelete(p.phone)}>
                  <Button size="small" type="danger" theme="borderless" icon={<IconDelete />} />
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
