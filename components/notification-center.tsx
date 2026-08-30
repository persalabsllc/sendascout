"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconBell, IconCheck, IconChecks } from "@tabler/icons-react";
import { markAllNotificationsRead, markNotificationRead } from "@/app/actions/missions";

export type NotificationCenterItem = {
  id: string;
  title: string;
  body: string;
  actionUrl: string | null;
  actionLabel: string | null;
  readAt: string | null;
  createdAt: string;
};

export function NotificationCenter({ items }: { items: NotificationCenterItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const unread = items.filter((item) => !item.readAt).length;
  const run = (action: () => Promise<void>) => startTransition(async () => { await action(); router.refresh(); });

  return <section className="notification-center-card">
    <div className="notification-center-heading">
      <div><span><IconBell size={22} /></span><div><h2>Notifications</h2><p>{unread ? `${unread} unread update${unread === 1 ? "" : "s"}` : "You’re all caught up."}</p></div></div>
      {unread > 0 && <button disabled={pending} onClick={() => run(markAllNotificationsRead)} type="button"><IconChecks size={17} /> Mark all read</button>}
    </div>
    {items.length ? <div className="notification-center-list">{items.map((item) => <article className={item.readAt ? "read" : "unread"} key={item.id}>
      <span className="notification-dot" aria-label={item.readAt ? "Read" : "Unread"} />
      <div><small>{new Date(item.createdAt).toLocaleString()}</small><strong>{item.title}</strong><p>{item.body}</p></div>
      <div className="notification-actions">
        {!item.readAt && <button aria-label={`Mark ${item.title} read`} disabled={pending} onClick={() => run(() => markNotificationRead(item.id))} type="button"><IconCheck size={16} /> Read</button>}
        {item.actionUrl && <Link href={item.actionUrl} onClick={() => { if (!item.readAt) run(() => markNotificationRead(item.id)); }}>{item.actionLabel || "Open"} <IconArrowRight size={16} /></Link>}
      </div>
    </article>)}</div> : <div className="notification-center-empty"><IconBell size={30} /><h3>No notifications yet</h3><p>Mission alerts and important account updates will appear here.</p></div>}
  </section>;
}
