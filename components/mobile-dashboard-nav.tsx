"use client";

import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import {
  IconDashboard,
  IconBell,
  IconBuildingStore,
  IconCalendarRepeat,
  IconHome,
  IconLifebuoy,
  IconLogout,
  IconMenu2,
  IconSettings,
  IconTargetArrow,
  IconUser,
  IconWallet,
  IconX,
} from "@tabler/icons-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Brand } from "./brand";

type MobileDashboardNavProps = {
  role: "customer" | "scout";
  name: string;
  initials: string;
};

export function MobileDashboardNav({ role, name, initials }: MobileDashboardNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const scout = role === "scout";
  const items = scout
    ? [
        { href: "/dashboard/scout", label: "Overview", icon: IconDashboard },
        { href: "/dashboard/scout/missions", label: "Mission board", icon: IconTargetArrow },
        { href: "/dashboard/scout/earnings", label: "Earnings & payouts", icon: IconWallet },
        { href: "/dashboard/scout/settings", label: "Profile & settings", icon: IconSettings },
        { href: "/dashboard/notifications", label: "Notifications", icon: IconBell },
      ]
    : [
        { href: "/dashboard/customer", label: "Overview", icon: IconDashboard },
        { href: "/dashboard/customer", label: "My missions", icon: IconTargetArrow },
        { href: "/dashboard/customer/saved", label: "Saved & recurring", icon: IconCalendarRepeat },
        { href: "/dashboard/customer/business", label: "Business", icon: IconBuildingStore },
        { href: "/dashboard/customer/payments", label: "Payments", icon: IconWallet },
        { href: "/dashboard/customer/support", label: "Contact Support", icon: IconLifebuoy },
        { href: "/dashboard/customer/profile", label: "Profile & settings", icon: IconUser },
        { href: "/dashboard/notifications", label: "Notifications", icon: IconBell },
      ];

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [open]);

  return <>
    <button
      aria-controls="mobile-dashboard-navigation"
      aria-expanded={open}
      aria-label="Open navigation"
      className="mobile-nav-trigger"
      onClick={() => setOpen(true)}
      ref={triggerRef}
      type="button"
    ><IconMenu2 size={23} /></button>
    {open && <>
      <button aria-label="Close navigation" className="mobile-nav-backdrop" onClick={() => setOpen(false)} type="button" />
      <aside aria-label="Dashboard navigation" aria-modal="true" className="mobile-nav-drawer" id="mobile-dashboard-navigation" ref={drawerRef} role="dialog">
        <div className="mobile-nav-heading"><Brand /><button aria-label="Close navigation" onClick={() => setOpen(false)} ref={closeButtonRef} type="button"><IconX size={22} /></button></div>
        <nav>{items.map(({ href, label, icon: Icon }) => {
          const active = href === pathname || (href !== `/dashboard/${role}` && pathname.startsWith(`${href}/`));
          return <Link className={active ? "active" : ""} href={href} key={label} onClick={() => setOpen(false)}><Icon size={21} />{label}</Link>;
        })}</nav>
        <div className="mobile-nav-bottom">
          <Link href="/" onClick={() => setOpen(false)}><IconHome size={20} /> Send a Scout home</Link>
          <SignOutButton redirectUrl="/"><button type="button"><IconLogout size={20} /> Sign out</button></SignOutButton>
          <div className="dash-user"><span>{initials}</span><div><strong>{name || "Your account"}</strong><small>{scout ? "Founding Scout" : "Customer"}</small></div></div>
        </div>
      </aside>
    </>}
  </>;
}
