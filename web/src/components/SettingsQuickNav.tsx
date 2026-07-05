import { useEffect, useState } from "react";

import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/constants/settings-sections";

const STICKY_NAV_HEIGHT = 56;

function getScrollContainer(): HTMLElement | null {
  return document.querySelector(".app-content-scroll");
}

function scrollToSection(id: SettingsSectionId) {
  const el = document.getElementById(id);
  const container = getScrollContainer();
  if (!el || !container) return;
  const containerTop = container.getBoundingClientRect().top;
  const elTop = el.getBoundingClientRect().top;
  const nextTop = container.scrollTop + (elTop - containerTop) - STICKY_NAV_HEIGHT;
  container.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" });
}

export default function SettingsQuickNav() {
  const [active, setActive] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    const container = getScrollContainer();
    if (!container) return;

    const sections = SETTINGS_SECTIONS.map(({ id }) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    if (!sections.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const id = visible[0]?.target.id as SettingsSectionId | undefined;
        if (id) setActive(id);
      },
      {
        root: container,
        rootMargin: `-${STICKY_NAV_HEIGHT}px 0px -55% 0px`,
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="settings-quick-nav-sticky" aria-label="设置快速导航">
      <div className="settings-quick-nav">
        {SETTINGS_SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`settings-quick-nav-item${active === id ? " is-active" : ""}`}
            aria-current={active === id ? "true" : undefined}
            onClick={() => scrollToSection(id)}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
