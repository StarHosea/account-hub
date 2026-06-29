"use client";

import { AlertTriangle, LoaderCircle, Play, RotateCcw, Save, Square, UserPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RegisterProvider, RegisterProviderType } from "@/lib/api";

import { useSettingsStore } from "../../settings/store";

export function RegisterCard() {
  const config = useSettingsStore((state) => state.registerConfig);
  const isLoading = useSettingsStore((state) => state.isLoadingRegister);
  const isSaving = useSettingsStore((state) => state.isSavingRegister);
  const setProxy = useSettingsStore((state) => state.setRegisterProxy);
  const setTotal = useSettingsStore((state) => state.setRegisterTotal);
  const setThreads = useSettingsStore((state) => state.setRegisterThreads);
  const setMailField = useSettingsStore((state) => state.setRegisterMailField);
  const setProviderType = useSettingsStore((state) => state.setRegisterProviderType);
  const updateProvider = useSettingsStore((state) => state.updateRegisterProvider);
  const save = useSettingsStore((state) => state.saveRegister);
  const toggle = useSettingsStore((state) => state.toggleRegister);
  const reset = useSettingsStore((state) => state.resetRegister);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-stone-200 bg-white/80 p-10">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  if (!config) return null;

  const stats = config.stats || { success: 0, fail: 0, done: 0, running: 0, threads: config.threads };
  const logs = config.logs || [];
  const provider: RegisterProvider = config.mail.providers?.[0] || { type: "api_mailbox", enable: true };
  const providerType: RegisterProviderType = provider.type === "cloudmail_gen" ? "cloudmail_gen" : "api_mailbox";
  const domains = Array.isArray(provider.domain) ? provider.domain.map(String).join("\n") : "";
  const subdomains = Array.isArray(provider.subdomain) ? provider.subdomain.map(String).join("\n") : "";

  return (
    <div className="grid h-[calc(100vh-132px)] min-h-[640px] items-stretch gap-0 overflow-hidden rounded-xl border border-stone-200 bg-white/70 xl:grid-cols-2">
      <section className="space-y-4 overflow-y-auto border-b border-stone-200 p-4 xl:border-r xl:border-b-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md bg-stone-100">
              <UserPlus className="size-5 text-stone-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">注册配置</h2>
            </div>
          </div>
          <Button
            className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800"
            onClick={() => void save()}
            disabled={isSaving || config.enabled}
          >
            {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存配置
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-sm text-stone-700">目标注册数量</label>
            <Input
              value={String(config.total)}
              onChange={(event) => setTotal(event.target.value)}
              className="h-10 rounded-xl border-stone-200 bg-white"
              disabled={config.enabled}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">并发数</label>
            <Input
              value={String(config.threads)}
              onChange={(event) => setThreads(event.target.value)}
              className="h-10 rounded-xl border-stone-200 bg-white"
              disabled={config.enabled}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">注册代理</label>
            <Input
              value={config.proxy}
              onChange={(event) => setProxy(event.target.value)}
              placeholder="socks5://user:pass@host:port"
              className="h-10 rounded-xl border-stone-200 bg-white"
              disabled={config.enabled}
            />
          </div>
        </div>
        <p className="text-xs text-stone-500">注册走代理；收邮件不走代理。例如 socks5://user:pass@host:port。</p>

        <div className="space-y-3 border-t border-stone-200 pt-3">
          <div>
            <h3 className="text-sm font-semibold text-stone-800">邮箱配置</h3>
            <p className="mt-1 text-xs text-stone-500">选择邮箱来源模式。</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-stone-700">邮箱模式</label>
            <Select
              value={providerType}
              onValueChange={(value) => setProviderType(value as RegisterProviderType)}
              disabled={config.enabled}
            >
              <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="api_mailbox">API邮箱</SelectItem>
                <SelectItem value="cloudmail_gen">CloudMail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {providerType === "api_mailbox" ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-6 text-stone-600">
              邮箱来自「邮箱管理」页面导入的 API 邮箱池，无需在此额外配置。
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">CloudMail URL（api_base）</label>
                  <Input
                    value={String(provider.api_base || "")}
                    onChange={(event) => updateProvider({ api_base: event.target.value })}
                    className="h-10 rounded-xl border-stone-200 bg-white"
                    disabled={config.enabled}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">邮箱前缀（email_prefix）</label>
                  <Input
                    value={String(provider.email_prefix || "")}
                    onChange={(event) => updateProvider({ email_prefix: event.target.value })}
                    className="h-10 rounded-xl border-stone-200 bg-white"
                    disabled={config.enabled}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">管理员邮箱（admin_email）</label>
                  <Input
                    value={String(provider.admin_email || "")}
                    onChange={(event) => updateProvider({ admin_email: event.target.value })}
                    className="h-10 rounded-xl border-stone-200 bg-white"
                    disabled={config.enabled}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">管理员密码（admin_password）</label>
                  <Input
                    type="password"
                    value={String(provider.admin_password || "")}
                    onChange={(event) => updateProvider({ admin_password: event.target.value })}
                    className="h-10 rounded-xl border-stone-200 bg-white"
                    disabled={config.enabled}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">邮箱域名（domain，每行一个）</label>
                <Textarea
                  value={domains}
                  onChange={(event) =>
                    updateProvider({ domain: event.target.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) })
                  }
                  placeholder="每行一个域名，留空则使用服务默认域名"
                  className="min-h-20 rounded-xl border-stone-200 bg-white font-mono text-xs"
                  disabled={config.enabled}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-stone-700">子域名（subdomain，每行一个）</label>
                <Textarea
                  value={subdomains}
                  onChange={(event) =>
                    updateProvider({ subdomain: event.target.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) })
                  }
                  placeholder="每行一个子域名前缀，留空则直接使用主域名"
                  className="min-h-20 rounded-xl border-stone-200 bg-white font-mono text-xs"
                  disabled={config.enabled}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 border-t border-stone-200 pt-3 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm text-stone-700">收件请求超时</label>
              <Input
                value={String(config.mail.request_timeout || "")}
                onChange={(event) => setMailField("request_timeout", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
                disabled={config.enabled}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">等待验证码超时</label>
              <Input
                value={String(config.mail.wait_timeout || "")}
                onChange={(event) => setMailField("wait_timeout", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
                disabled={config.enabled}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">轮询间隔</label>
              <Input
                value={String(config.mail.wait_interval || "")}
                onChange={(event) => setMailField("wait_interval", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
                disabled={config.enabled}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="flex min-h-0 flex-col p-4">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">运行结果</h2>
              <p className="mt-1 text-sm text-stone-500">SSE 实时推送当前状态。</p>
            </div>
            <Badge variant={config.enabled ? "success" : "secondary"} className="rounded-md">
              {config.enabled ? "运行中" : "已停止"}
            </Badge>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[
              ["成功 / 成功率", `${stats.success} / ${stats.success_rate || 0}%`],
              ["失败", stats.fail],
              ["完成", stats.done],
              ["运行 / 线程", `${stats.running} / ${stats.threads}`],
              ["运行时间", `${stats.elapsed_seconds || 0}s`],
              ["平均注册单个", `${stats.avg_seconds || 0}s`],
              ["正常账号", stats.current_available || 0],
            ].map(([label, value]) => (
              <div key={label} className="border border-stone-200 bg-white/70 px-3 py-2">
                <div className="text-xs text-stone-400">{label}</div>
                <div className="mt-1 text-base font-semibold text-stone-800">{value}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button
              className="h-10 rounded-xl bg-stone-950 px-3 text-white hover:bg-stone-800"
              onClick={() => void toggle()}
              disabled={isSaving}
            >
              {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : config.enabled ? <Square className="size-4" /> : <Play className="size-4" />}
              {config.enabled ? "停止" : "启动"}
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-xl border-stone-200 bg-white px-3 text-stone-700"
              onClick={() => void reset()}
              disabled={isSaving || config.enabled}
            >
              <RotateCcw className="size-4" />
              重置
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-xl border-stone-200 bg-white px-3 text-stone-700"
              onClick={() => void save()}
              disabled={isSaving || config.enabled}
            >
              <Save className="size-4" />
              保存
            </Button>
          </div>
          <div className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="size-4 shrink-0" />
            启动之前注意先保存配置。
          </div>
        </div>

        <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-3 overflow-hidden border-t border-stone-200 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-stone-900">实时日志</h3>
              <p className="mt-1 text-xs text-amber-700">遇到 HTTP 状态码 400 等错误，基本是邮箱滥用被封，需要更换新的域名邮箱。</p>
            </div>
            <Badge variant="secondary" className="rounded-md">
              {logs.length}
            </Badge>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto border border-stone-200 bg-white/70 p-3 font-mono text-xs leading-6">
            {logs.length === 0 ? (
              <div className="text-stone-500">暂无日志</div>
            ) : (
              logs.slice().reverse().map((item, index) => (
                <div
                  key={`${item.time}-${index}`}
                  className={item.level === "red" ? "text-rose-600" : item.level === "green" ? "text-emerald-700" : item.level === "yellow" ? "text-amber-700" : "text-stone-700"}
                >
                  <span className="text-stone-400">{new Date(item.time).toLocaleTimeString()}</span>
                  <span className="pl-2">{item.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
