
import { create } from "zustand";
import { toast } from "sonner";
import {
  fetchActivation,
  fetchRegisterConfig,
  fetchSettingsConfig,
  resetRegister as resetRegisterApi,
  startRegister,
  stopRegister,
  updateActivationConfig,
  updateRegisterConfig,
  updateSettingsConfig,
  type ActivationConfig,
  type RegisterConfig,
  type RegisterProvider,
  type RegisterProviderType,
  type SettingsConfig,
} from "@/lib/api";
import { navRef } from "@/constants/nav";
import {
  buildRegisterProxyPayload,
  DEFAULT_HTTP_PROXY,
  defaultIpwebFields,
  hydrateRegisterProxyFields,
  type RegisterProxyMode,
} from "@/lib/register-proxy";

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  return {
    ...config,
    auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
    auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    global_system_prompt: String(config.global_system_prompt || ""),
    sensitive_words: Array.isArray(config.sensitive_words) ? config.sensitive_words : [],
  };
}

type SettingsStore = {
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;

  registerConfig: RegisterConfig | null;
  isLoadingRegister: boolean;
  isSavingRegister: boolean;

  activationConfig: ActivationConfig | null;
  isLoadingActivationConfig: boolean;
  isSavingActivationConfig: boolean;

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<boolean>;
  setAutoRemoveInvalidAccounts: (value: boolean) => void;
  setAutoRemoveRateLimitedAccounts: (value: boolean) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setProxy: (value: string) => void;
  setGlobalSystemPrompt: (value: string) => void;
  setSensitiveWordsText: (value: string) => void;

  loadRegister: (silent?: boolean) => Promise<void>;
  setRegisterConfig: (config: RegisterConfig) => void;
  setRegisterProxyMode: (mode: RegisterProxyMode) => void;
  setRegisterHttpProxy: (value: string) => void;
  setRegisterIpwebGateway: (value: string) => void;
  setRegisterIpwebAccountId: (value: string) => void;
  setRegisterIpwebPassword: (value: string) => void;
  setRegisterTotal: (value: string) => void;
  setRegisterThreads: (value: string) => void;
  setRegisterEnable2fa: (value: boolean) => void;
  setRegisterRegions: (values: string[]) => void;
  setRegisterTimeoutMinutes: (value: number) => void;
  setRegisterStaticCacheEnabled: (value: boolean) => void;
  setRegisterStaticCacheMaxAgeDays: (value: number) => void;
  setRegisterStaticCacheDir: (value: string) => void;
  setRegisterRecordEnabled: (value: boolean) => void;
  setRegisterRecordDir: (value: string) => void;
  setRegisterRecordKeep: (value: "fail" | "all" | "none") => void;
  setRegisterDiagPublicUrl: (value: string) => void;
  setRegisterMailField: (key: "request_timeout" | "wait_timeout" | "wait_interval", value: string) => void;
  setRegisterProviderType: (type: RegisterProviderType) => void;
  updateRegisterProvider: (updates: Partial<RegisterProvider>) => void;
  saveRegister: (opts?: { silent?: boolean }) => Promise<void>;
  toggleRegister: () => Promise<void>;
  stopRegisterRun: () => Promise<void>;
  resetRegister: () => Promise<void>;

  loadActivationConfig: () => Promise<void>;
  setActivationConfig: (config: ActivationConfig) => void;
  setActivationConfigField: (
    key: "base_url" | "api_key" | "concurrency" | "poll_interval" | "poll_timeout" | "max_attempts_per_type" | "timeout_retry_max" | "failed_retry_max" | "target",
    value: string,
  ) => void;
  setActivationAutoActivate: (value: boolean) => void;
  saveActivationConfig: (opts?: { silent?: boolean }) => Promise<void>;
};

function clampRegisterTimeoutSeconds(seconds: number): number {
  return Math.min(1800, Math.max(60, Math.round(seconds)));
}

function registerTimeoutMinutes(config: RegisterConfig): number {
  return Math.round(clampRegisterTimeoutSeconds(Number(config.register_timeout) || 600) / 60);
}

function withRegisterProxyFields(config: RegisterConfig): RegisterConfig {
  return hydrateRegisterProxyFields(config);
}

function buildRegisterPayload(config: RegisterConfig): Partial<RegisterConfig> {
  const register_timeout = clampRegisterTimeoutSeconds(
    Number(config.register_timeout) || registerTimeoutMinutes(config) * 60,
  );
  let proxyPayload: ReturnType<typeof buildRegisterProxyPayload>;
  try {
    proxyPayload = buildRegisterProxyPayload(config);
  } catch (error) {
    throw error instanceof Error ? error : new Error("注册代理配置无效");
  }
  return {
    mail: config.mail,
    proxy: proxyPayload.proxy,
    proxy_mode: proxyPayload.proxy_mode,
    http_proxy: proxyPayload.http_proxy,
    total: Math.max(1, Number(config.total) || 1),
    threads: Math.max(1, Number(config.threads) || 1),
    enable_2fa: Boolean(config.enable_2fa),
    regions: config.regions && config.regions.length ? config.regions : ["US"],
    ipweb_rotate: proxyPayload.ipweb_rotate,
    register_timeout,
    static_cache_enabled: config.static_cache_enabled !== false,
    static_cache_max_age_days: Math.min(90, Math.max(1, Number(config.static_cache_max_age_days) || 7)),
    static_cache_dir: String(config.static_cache_dir || "").trim(),
    record_enabled: config.record_enabled !== false,
    record_dir: String(config.record_dir || "").trim(),
    record_keep: (["fail", "all", "none"].includes(String(config.record_keep || "fail"))
      ? String(config.record_keep)
      : "fail") as "fail" | "all" | "none",
    diag_public_url: String(config.diag_public_url || "").trim().replace(/\/$/, ""),
  };
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,

  registerConfig: null,
  isLoadingRegister: true,
  isSavingRegister: false,

  activationConfig: null,
  isLoadingActivationConfig: true,
  isSavingActivationConfig: false,

  initialize: async () => {
    await Promise.allSettled([get().loadConfig(), get().loadActivationConfig()]);
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      set({ config: normalizeConfig(data.config) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return false;
    }

    set({ isSavingConfig: true });
    try {
      const data = await updateSettingsConfig({
        ...config,
        auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
        auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
        proxy: config.proxy.trim(),
        global_system_prompt: String(config.global_system_prompt || "").trim(),
        sensitive_words: (config.sensitive_words || []).map((item) => String(item).trim()).filter(Boolean),
      });
      set({ config: normalizeConfig(data.config) });
      toast.success("配置已保存");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
      return false;
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setAutoRemoveInvalidAccounts: (value) => {
    set((state) => (state.config ? { config: { ...state.config, auto_remove_invalid_accounts: value } } : {}));
  },

  setAutoRemoveRateLimitedAccounts: (value) => {
    set((state) => (state.config ? { config: { ...state.config, auto_remove_rate_limited_accounts: value } } : {}));
  },

  setLogLevel: (level, enabled) => {
    set((state) => {
      if (!state.config) return {};
      const levels = new Set(state.config.log_levels || []);
      if (enabled) levels.add(level);
      else levels.delete(level);
      return { config: { ...state.config, log_levels: Array.from(levels) } };
    });
  },

  setProxy: (value) => {
    set((state) => (state.config ? { config: { ...state.config, proxy: value } } : {}));
  },

  setGlobalSystemPrompt: (value) => {
    set((state) => (state.config ? { config: { ...state.config, global_system_prompt: value } } : {}));
  },

  setSensitiveWordsText: (value) => {
    set((state) => (state.config ? { config: { ...state.config, sensitive_words: value.split("\n") } } : {}));
  },

  loadRegister: async (silent = false) => {
    if (!silent) set({ isLoadingRegister: true });
    try {
      const data = await fetchRegisterConfig();
      set({ registerConfig: withRegisterProxyFields(data.register) });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载注册配置失败");
    } finally {
      if (!silent) set({ isLoadingRegister: false });
    }
  },

  setRegisterConfig: (config) => {
    set({ registerConfig: withRegisterProxyFields(config), isLoadingRegister: false });
  },

  setRegisterProxyMode: (mode) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const next: RegisterConfig = { ...state.registerConfig, proxy_mode: mode };
      if (mode === "ipweb") {
        const defaults = defaultIpwebFields();
        if (!next.ipweb_gateway?.trim()) next.ipweb_gateway = defaults.gateway;
        if (!next.ipweb_account_id?.trim()) next.ipweb_account_id = defaults.accountId;
        if (!next.ipweb_password?.trim()) next.ipweb_password = defaults.password;
      }
      if (mode === "http" && !next.http_proxy?.trim()) {
        next.http_proxy = DEFAULT_HTTP_PROXY;
      }
      return { registerConfig: withRegisterProxyFields(next) };
    });
  },

  setRegisterHttpProxy: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, http_proxy: value } } : {},
    );
  },

  setRegisterIpwebGateway: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, ipweb_gateway: value } } : {},
    );
  },

  setRegisterIpwebAccountId: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, ipweb_account_id: value } } : {},
    );
  },

  setRegisterIpwebPassword: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, ipweb_password: value } } : {},
    );
  },

  setRegisterTotal: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, total: Number(value) || 0 } } : {},
    );
  },

  setRegisterThreads: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, threads: Number(value) || 0 } } : {},
    );
  },

  setRegisterEnable2fa: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, enable_2fa: value } } : {},
    );
  },

  setRegisterRegions: (values) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, regions: values } } : {},
    );
  },

  setRegisterTimeoutMinutes: (value) => {
    const minutes = Math.min(30, Math.max(1, Math.round(Number(value) || 10)));
    const register_timeout = minutes * 60;
    set((state) =>
      state.registerConfig
        ? {
            registerConfig: {
              ...state.registerConfig,
              register_timeout,
              ip_duration: minutes,
            },
          }
        : {},
    );
  },

  setRegisterStaticCacheEnabled: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, static_cache_enabled: value } } : {},
    );
  },

  setRegisterStaticCacheMaxAgeDays: (value) => {
    set((state) =>
      state.registerConfig
        ? { registerConfig: { ...state.registerConfig, static_cache_max_age_days: Math.min(90, Math.max(1, value)) } }
        : {},
    );
  },

  setRegisterStaticCacheDir: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, static_cache_dir: value } } : {},
    );
  },

  setRegisterRecordEnabled: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, record_enabled: value } } : {},
    );
  },

  setRegisterRecordDir: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, record_dir: value } } : {},
    );
  },

  setRegisterRecordKeep: (value) => {
    set((state) =>
      state.registerConfig ? { registerConfig: { ...state.registerConfig, record_keep: value } } : {},
    );
  },

  setRegisterDiagPublicUrl: (value) => {
    set((state) =>
      state.registerConfig
        ? { registerConfig: { ...state.registerConfig, diag_public_url: value.trim().replace(/\/$/, "") } }
        : {},
    );
  },

  setRegisterMailField: (key, value) => {
    set((state) =>
      state.registerConfig
        ? {
            registerConfig: {
              ...state.registerConfig,
              mail: { ...state.registerConfig.mail, [key]: Number(value) || 0 },
            },
          }
        : {},
    );
  },

  setRegisterProviderType: (type) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const existing = state.registerConfig.mail.providers?.[0] || ({} as RegisterProvider);
      const provider: RegisterProvider =
        type === "cloudmail_gen"
          ? {
              type,
              enable: true,
              api_base: String(existing.api_base || ""),
              admin_email: String(existing.admin_email || ""),
              admin_password: String(existing.admin_password || ""),
              domain: Array.isArray(existing.domain) ? existing.domain : [],
              subdomain: Array.isArray(existing.subdomain) ? existing.subdomain : [],
              email_prefix: String(existing.email_prefix || ""),
            }
          : { type, enable: true };
      return {
        registerConfig: {
          ...state.registerConfig,
          mail: { ...state.registerConfig.mail, providers: [provider] },
        },
      };
    });
  },

  updateRegisterProvider: (updates) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const providers = [...(state.registerConfig.mail.providers || [])];
      const current = providers[0] || ({ type: "api_mailbox", enable: true } as RegisterProvider);
      providers[0] = { ...current, ...updates };
      return {
        registerConfig: { ...state.registerConfig, mail: { ...state.registerConfig.mail, providers } },
      };
    });
  },

  saveRegister: async (opts) => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    set({ isSavingRegister: true });
    try {
      const data = await updateRegisterConfig(buildRegisterPayload(registerConfig));
      set({ registerConfig: withRegisterProxyFields(data.register) });
      if (!opts?.silent) toast.success("注册配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存注册配置失败");
      throw error;
    } finally {
      set({ isSavingRegister: false });
    }
  },

  toggleRegister: async () => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    set({ isSavingRegister: true });
    try {
      if (!registerConfig.enabled) {
        await updateRegisterConfig(buildRegisterPayload(registerConfig));
      }
      const data = registerConfig.enabled ? await stopRegister() : await startRegister();
      set({ registerConfig: withRegisterProxyFields(data.register) });
      toast.success(
        registerConfig.enabled
          ? "已停止注册：在途浏览器已终止，运行日志见批量注册页"
          : `注册任务已启动，请在${navRef("register")}查看运行日志`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换注册状态失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  stopRegisterRun: async () => {
    const { registerConfig } = get();
    if (!registerConfig?.enabled) return;
    set({ isSavingRegister: true });
    try {
      const data = await stopRegister();
      set({ registerConfig: withRegisterProxyFields(data.register) });
      toast.success("已停止注册：在途指纹浏览器已终止");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "停止注册失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  resetRegister: async () => {
    set({ isSavingRegister: true });
    try {
      const data = await resetRegisterApi();
      set({ registerConfig: withRegisterProxyFields(data.register) });
      toast.success("注册统计已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重置注册统计失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  loadActivationConfig: async () => {
    set({ isLoadingActivationConfig: true });
    try {
      const data = await fetchActivation();
      set({ activationConfig: data.config });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载 Plus 激活配置失败");
    } finally {
      set({ isLoadingActivationConfig: false });
    }
  },

  setActivationConfig: (config) => {
    set({ activationConfig: config });
  },

  setActivationConfigField: (key, value) => {
    set((state) => {
      if (!state.activationConfig) return {};
      if (key === "base_url" || key === "api_key") {
        return { activationConfig: { ...state.activationConfig, [key]: value } };
      }
      return { activationConfig: { ...state.activationConfig, [key]: Number(value) || 0 } };
    });
  },

  setActivationAutoActivate: (value) => {
    set((state) =>
      state.activationConfig
        ? { activationConfig: { ...state.activationConfig, auto_activate_after_register: value } }
        : {},
    );
  },

  saveActivationConfig: async (opts) => {
    const { activationConfig } = get();
    if (!activationConfig) return;
    set({ isSavingActivationConfig: true });
    try {
      const data = await updateActivationConfig({
        base_url: String(activationConfig.base_url || "").trim(),
        concurrency: Math.max(1, Number(activationConfig.concurrency) || 1),
        poll_interval: Math.max(1, Number(activationConfig.poll_interval) || 5),
        poll_timeout: Math.max(30, Number(activationConfig.poll_timeout) || 3600),
        max_attempts_per_type: Math.max(1, Number(activationConfig.max_attempts_per_type) || 1),
        timeout_retry_max: Math.max(0, Number(activationConfig.timeout_retry_max) || 0),
        failed_retry_max: Math.max(0, Number(activationConfig.failed_retry_max) || 0),
        auto_activate_after_register: Boolean(activationConfig.auto_activate_after_register),
        target: Math.max(0, Number(activationConfig.target) || 0),
        // 仅在用户填写了新 api_key 时提交（写入式字段）
        ...(activationConfig.api_key ? { api_key: activationConfig.api_key } : {}),
      });
      set({ activationConfig: data.config });
      if (!opts?.silent) toast.success("Plus 激活配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Plus 激活配置失败");
      throw error;
    } finally {
      set({ isSavingActivationConfig: false });
    }
  },
}));
