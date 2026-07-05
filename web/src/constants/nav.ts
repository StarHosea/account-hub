/** 侧栏菜单与页面标题共用文案（四字对齐，便于导航视觉统一）。 */
export const NAV_LABELS = {
  register: "批量注册",
  activator: "批量激活",
  accountsFree: "免费账号",
  accountsPlus: "会员账号",
  mailboxes: "邮箱管理",
  cdks: "激活码库",
  phones: "号码管理",
  dispatch: "账号出库",
  activationAudit: "激活审计",
  settings: "系统设置",
} as const;

export type NavLabelKey = keyof typeof NAV_LABELS;

export const NAV_ITEMS: { itemKey: string; text: string }[] = [
  { itemKey: "/register", text: NAV_LABELS.register },
  { itemKey: "/activator", text: NAV_LABELS.activator },
  { itemKey: "/accounts/free", text: NAV_LABELS.accountsFree },
  { itemKey: "/accounts/plus", text: NAV_LABELS.accountsPlus },
  { itemKey: "/mailboxes", text: NAV_LABELS.mailboxes },
  { itemKey: "/cdks", text: NAV_LABELS.cdks },
  { itemKey: "/phones", text: NAV_LABELS.phones },
  { itemKey: "/dispatch", text: NAV_LABELS.dispatch },
  { itemKey: "/activation-audit", text: NAV_LABELS.activationAudit },
  { itemKey: "/settings", text: NAV_LABELS.settings },
];

/** 在提示语中引用菜单名，例如「请先在「邮箱管理」中导入」。 */
export function navRef(key: NavLabelKey): string {
  return `「${NAV_LABELS[key]}」`;
}
