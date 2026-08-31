import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { ControlRoomSupport, type AdminSupportTicketView } from "@/components/control-room-support";
import { Brand } from "@/components/brand";
import { getDb } from "@/db";
import { customerSupportMessages, customerSupportTickets, missionBundles, missions, users } from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";
import type { CustomerSupportReason, CustomerSupportResolution } from "@/lib/customer-support-core";

export const metadata = { title: "Customer Support | Send a Scout Control Room", robots: { index: false, follow: false } };

export default async function ControlRoomSupportPage() {
  const admin = await requireAdminUser();
  const db = getDb();
  const ticketRows = await db.select({ ticket: customerSupportTickets, customer: users, mission: missions, bundle: missionBundles })
    .from(customerSupportTickets)
    .innerJoin(users, eq(users.id, customerSupportTickets.customerId))
    .leftJoin(missions, eq(missions.id, customerSupportTickets.missionId))
    .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
    .orderBy(desc(customerSupportTickets.updatedAt))
    .limit(100);
  const ticketIds = ticketRows.map(({ ticket }) => ticket.id);
  const messageRows = ticketIds.length
    ? await db.select({ message: customerSupportMessages, author: users })
      .from(customerSupportMessages)
      .innerJoin(users, eq(users.id, customerSupportMessages.authorId))
      .where(inArray(customerSupportMessages.ticketId, ticketIds))
      .orderBy(customerSupportMessages.createdAt)
    : [];
  const messagesByTicket = new Map<string, AdminSupportTicketView["messages"]>();
  for (const { message, author } of messageRows) {
    const list = messagesByTicket.get(message.ticketId) ?? [];
    list.push({ id: message.id, authorRole: message.authorRole as "customer" | "admin", authorName: message.authorRole === "admin" ? "Send a Scout Support" : [author.firstName, author.lastName].filter(Boolean).join(" ") || author.email, body: message.body, createdAt: message.createdAt.toISOString() });
    messagesByTicket.set(message.ticketId, list);
  }
  return <main className="control-page">
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room">Operations</Link><Link href="/control-room/analytics">Analytics</Link><Link href="/control-room/customers">Customers</Link><Link href="/control-room/scouts">Scouts</Link><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <div className="control-title"><div><span className="kicker">Customer care</span><h1>Support tickets</h1><p>Review customer issues, reply, and send resolutions for customer approval.</p></div><Link className="button button-small button-ghost" href="/control-room">Back to operations</Link></div>
      <ControlRoomSupport tickets={ticketRows.map(({ ticket, customer, mission, bundle }) => ({
        id: ticket.id,
        customer: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email,
        customerEmail: customer.email,
        reason: ticket.reason as CustomerSupportReason,
        status: ticket.status as AdminSupportTicketView["status"],
        missionId: ticket.missionId,
        missionTitle: bundle?.title ?? mission?.title ?? null,
        maximumRefundCents: bundle?.customerPriceCents ?? mission?.customerPriceCents ?? 0,
        resolutionType: ticket.resolutionType as CustomerSupportResolution | null,
        resolutionAmountCents: ticket.resolutionAmountCents,
        resolutionNote: ticket.resolutionNote,
        customerDecision: ticket.customerDecision,
        financialApprovalPending: ticket.status === "open"
          && ["full_refund", "partial_refund"].includes(ticket.resolutionType ?? "")
          && ticket.resolutionAmountCents > 10_000
          && Boolean(ticket.proposedBy)
          && !ticket.financialApprovedBy,
        proposedByCurrentAdmin: ticket.proposedBy === admin.id,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        messages: messagesByTicket.get(ticket.id) ?? [],
      }))} />
    </div>
  </main>;
}
