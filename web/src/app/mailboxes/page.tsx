"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteMailboxes,
  fetchMailboxes,
  importMailboxes,
  markMailboxes,
  type Mailbox,
  type MailboxStats,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const emptyStats: MailboxStats = { total: 0, used: 0, unused: 0, in_use: 0 };

const metricCards = [
  { key: "total", label: "总数", color: "text-stone-900", icon: Mail },
  { key: "unused", label: "未使用", color: "text-emerald-600", icon: CheckCircle2 },
  { key: "used", label: "已用", color: "text-stone-500", icon: CheckCircle2 },
  { key: "in_use", label: "占用中", color: "text-blue-500", icon: RefreshCw },
] as const;

function maskToken(token?: string | null) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 12)}...${token.slice(-6)}`;
}

function truncateUrl(url: string) {
  if (url.length <= 48) return url;
  return `${url.slice(0, 30)}...${url.slice(-12)}`;
}

function MailboxesPageContent() {
  const didLoadRef = useRef(false);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [stats, setStats] = useState<MailboxStats>(emptyStats);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isMarking, setIsMarking] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const loadMailboxes = async () => {
    setIsLoading(true);
    try {
      const data = await fetchMailboxes();
      setMailboxes(data.items);
      setStats(data.stats);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.email === id)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载邮箱列表失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void loadMailboxes();
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return mailboxes;
    return mailboxes.filter((item) => item.email.toLowerCase().includes(normalizedQuery));
  }, [mailboxes, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filtered.slice(startIndex, startIndex + Number(pageSize));
  const allCurrentSelected =
    currentRows.length > 0 && currentRows.every((row) => selectedIds.includes(row.email));

  const selectedEmails = useMemo(() => {
    const set = new Set(selectedIds);
    return mailboxes.filter((item) => set.has(item.email)).map((item) => item.email);
  }, [mailboxes, selectedIds]);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);
    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);
    return items;
  }, [pageCount, safePage]);

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.email)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.email === id)));
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      toast.error("请先粘贴要导入的邮箱");
      return;
    }
    setIsImporting(true);
    try {
      const data = await importMailboxes(importText);
      setMailboxes(data.items);
      setStats(data.stats);
      setImportText("");
      setImportOpen(false);
      setPage(1);
      toast.success(`导入完成，新增 ${data.result.added} 个，更新 ${data.result.updated} 个`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入邮箱失败");
    } finally {
      setIsImporting(false);
    }
  };

  const handleDelete = async (emails: string[]) => {
    if (emails.length === 0) {
      toast.error("请先选择要删除的邮箱");
      return;
    }
    setIsDeleting(true);
    try {
      const data = await deleteMailboxes(emails);
      setMailboxes(data.items);
      setStats(data.stats);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.email === id)));
      toast.success(`删除 ${data.removed} 个邮箱`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除邮箱失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleMark = async (emails: string[], used: boolean) => {
    if (emails.length === 0) {
      toast.error("请先选择要操作的邮箱");
      return;
    }
    setIsMarking(true);
    try {
      const data = await markMailboxes(emails, used);
      setMailboxes(data.items);
      setStats(data.stats);
      toast.success(`已${used ? "标记为已用" : "取消标记"} ${data.changed} 个邮箱`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "标记邮箱失败");
    } finally {
      setIsMarking(false);
    }
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Mailbox Pool</div>
          <h1 className="text-2xl font-semibold tracking-tight">邮箱管理</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void loadMailboxes()}
            disabled={isLoading}
          >
            <RefreshCw className={cn("size-4", isLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            className="h-10 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-4" />
            批量导入
          </Button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((item) => {
          const Icon = item.icon;
          const value = stats[item.key];
          return (
            <Card key={item.key} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="p-4">
                <div className="mb-4 flex items-start justify-between">
                  <span className="text-xs font-medium text-stone-400">{item.label}</span>
                  <Icon className="size-4 text-stone-400" />
                </div>
                <div className={cn("text-[1.75rem] font-semibold tracking-tight", item.color)}>{value}</div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">邮箱列表</h2>
            <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
              {filtered.length}
            </Badge>
          </div>
          <div className="relative min-w-[260px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="搜索邮箱"
              className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10"
            />
          </div>
        </div>

        <Card className="overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="space-y-0 p-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3 text-sm text-stone-500">
              <Button
                variant="ghost"
                className="h-8 rounded-lg px-3 text-stone-500 hover:bg-stone-100"
                onClick={() => void handleMark(selectedEmails, true)}
                disabled={selectedEmails.length === 0 || isMarking}
              >
                {isMarking ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                标记为已用
              </Button>
              <Button
                variant="ghost"
                className="h-8 rounded-lg px-3 text-stone-500 hover:bg-stone-100"
                onClick={() => void handleMark(selectedEmails, false)}
                disabled={selectedEmails.length === 0 || isMarking}
              >
                {isMarking ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                取消标记
              </Button>
              <Button
                variant="ghost"
                className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                onClick={() => void handleDelete(selectedEmails)}
                disabled={selectedEmails.length === 0 || isDeleting}
              >
                {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                删除选中
              </Button>
              {selectedIds.length > 0 ? (
                <span className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                  已选择 {selectedIds.length} 项
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left">
                <thead className="border-b border-stone-100 text-[11px] uppercase tracking-[0.18em] text-stone-400">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <Checkbox
                        checked={allCurrentSelected}
                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                      />
                    </th>
                    <th className="w-64 px-4 py-3">邮箱</th>
                    <th className="w-64 px-4 py-3">取件地址</th>
                    <th className="w-24 px-4 py-3">状态</th>
                    <th className="w-48 px-4 py-3">绑定账号</th>
                    <th className="w-24 px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {currentRows.map((item) => (
                    <tr
                      key={item.email}
                      className="border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-stone-50/70"
                    >
                      <td className="px-4 py-3">
                        <Checkbox
                          checked={selectedIds.includes(item.email)}
                          onCheckedChange={(checked) => {
                            setSelectedIds((prev) =>
                              checked
                                ? Array.from(new Set([...prev, item.email]))
                                : prev.filter((id) => id !== item.email),
                            );
                          }}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-stone-700">{item.email}</span>
                          <button
                            type="button"
                            className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                            onClick={() => {
                              void navigator.clipboard.writeText(item.email);
                              toast.success("邮箱已复制");
                            }}
                          >
                            <Copy className="size-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-stone-500" title={item.fetch_url}>
                            {truncateUrl(item.fetch_url)}
                          </span>
                          <button
                            type="button"
                            className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                            onClick={() => {
                              void navigator.clipboard.writeText(item.fetch_url);
                              toast.success("取件地址已复制");
                            }}
                          >
                            <Copy className="size-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {item.used ? (
                          <Badge variant="secondary" className="rounded-md bg-stone-100 text-stone-700">
                            已用
                          </Badge>
                        ) : item.in_use ? (
                          <Badge variant="info" className="rounded-md">
                            占用中
                          </Badge>
                        ) : (
                          <Badge variant="success" className="rounded-md">
                            未使用
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs leading-5 text-stone-500">
                        {item.account_token ? maskToken(item.account_token) : item.registered_at || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="rounded-lg p-2 text-stone-400 transition hover:bg-rose-50 hover:text-rose-500"
                          onClick={() => void handleDelete([item.email])}
                          disabled={isDeleting}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!isLoading && currentRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <Search className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">没有匹配的邮箱</p>
                    <p className="text-sm text-stone-500">导入邮箱或调整搜索关键字后重试。</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                  显示第 {filtered.length === 0 ? 0 : startIndex + 1} -{" "}
                  {Math.min(startIndex + Number(pageSize), filtered.length)} 条，共 {filtered.length} 条
                </div>
                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 / 页</SelectItem>
                    <SelectItem value="20">20 / 页</SelectItem>
                    <SelectItem value="50">50 / 页</SelectItem>
                    <SelectItem value="100">100 / 页</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-stone-400">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>批量导入邮箱</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              每行一个，格式为 邮箱----取件地址URL。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder={"example@icloud.com----https://icloud-api.top/show/..."}
              className="min-h-56 resize-none rounded-xl border-stone-200 font-mono text-xs"
            />
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setImportOpen(false)}
              disabled={isImporting}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleImport()}
              disabled={isImporting}
            >
              {isImporting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function MailboxesPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <MailboxesPageContent />;
}
