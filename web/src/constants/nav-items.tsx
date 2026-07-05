import {
  IconPlay,
  IconBolt,
  IconUser,
  IconStar,
  IconMail,
  IconTicketCode,
  IconPhone,
  IconSend,
  IconSetting,
  IconHistory,
} from "@douyinfe/semi-icons";

import { NAV_LABELS } from "@/constants/nav";

export const NAV_MENU_ITEMS = [
  { itemKey: "/register", text: NAV_LABELS.register, icon: <IconPlay /> },
  { itemKey: "/activator", text: NAV_LABELS.activator, icon: <IconBolt /> },
  { itemKey: "/accounts/free", text: NAV_LABELS.accountsFree, icon: <IconUser /> },
  { itemKey: "/accounts/plus", text: NAV_LABELS.accountsPlus, icon: <IconStar /> },
  { itemKey: "/mailboxes", text: NAV_LABELS.mailboxes, icon: <IconMail /> },
  { itemKey: "/cdks", text: NAV_LABELS.cdks, icon: <IconTicketCode /> },
  { itemKey: "/phones", text: NAV_LABELS.phones, icon: <IconPhone /> },
  { itemKey: "/dispatch", text: NAV_LABELS.dispatch, icon: <IconSend /> },
  { itemKey: "/activation-audit", text: NAV_LABELS.activationAudit, icon: <IconHistory /> },
  { itemKey: "/settings", text: NAV_LABELS.settings, icon: <IconSetting /> },
];
