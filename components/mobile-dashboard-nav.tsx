"use client";

import Link from "next/link";
import { SignOutButton } from "@clerk/nextjs";
import {
  IconDashboard,
  IconHome,
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
  const scout = role === "scout";
  const items = scout
    ? [
        { href: "/dashboard/scout", label: "Overview", icon: IconDashboard },
        { href: "/dashboard/scout/missions", label: "Mission board", icon: IconTargetArrow },
        { href: "/dashboard/scout/earnings", label: "Earnings & payouts", icon: IconWallet },
        { href: "/dashboard/scout/settings", label: "Profile & settings", icon: IconSettings },
      ]
    : [
        { href: "/dashboard/customer", label: "Overview", icon: IconDashboard },
        { href: "/dashboard/customer", label: "My missions", icon: IconTargetArrow },
        { href: "/dashboard/customer/payments", label: "Payments", icon: IconWallet },
        { href: "/dashboard/customer/profile", label: "Profile & settings", icon: IconUser },
      ];

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <>
    <button
      aria-controls="mobile-dashboard-navigation"
      aria-expanded={open}
      aria-label="Open navigation"
      className="mobile-nav-trigger"
      onClick={() => setOpen(true)}
      type="button"
    ><IconMenu2 size={23} /></button>
    {open && <>
      <button aria-label="Close navigation" className="mobile-nav-backdrop" onClick={() => setOpen(false)} type="button" />
      <aside aria-label="Dashboard navigation" aria-modal="true" className="mobile-nav-drawer" id="mobile-dashboard-navigation" role="dialog">
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
