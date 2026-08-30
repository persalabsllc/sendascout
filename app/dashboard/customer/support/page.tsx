import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { CustomerDashboardShell } from "@/components/customer-dashboard-shell";
import { CustomerSupportCenter, type CustomerSupportTicketView } from "@/components/customer-support-center";
import { getDb } from "@/db";
import {
  customerCredits,
  customerSupportMessages,
  customerSupportTickets,
  missionBundles,
  missions,
  users,
} from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import type { CustomerSupportReason, CustomerSupportResolution } from "@/lib/customer-support-core";

export const metadata = { title: "Customer Support | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerSupportPage() {
  const customer = await requireAppUser("customer");
  const db = getDb();
  const [ticketRows, missionRows, [creditBalance]] = await Promise.all([
    db.select({ ticket: customerSupportTickets, missionTitle: missions.title })
      .from(customerSupportTickets)
      .leftJoin(missions, eq(missions.id, customerSupportTickets.missionId))
      .where(eq(customerSupportTickets.customerId, customer.id))
      .orderBy(desc(customerSupportTickets.updatedAt)),
    db.select({ mission: missions, bundle: missionBundles })
      .from(missions)
      .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
      .where(and(
        eq(missions.customerId, customer.id),
        isNull(missions.archivedAt),
        or(
          inArray(missions.status, ["draft", "open", "claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted", "disputed"]),
          sql`${missions.createdAt} > now() - interval '90 days'`,
        ),
      ))
      .orderBy(desc(missions.createdAt))
      .limit(40),
    db.select({ total: sql<number>`COALESCE(SUM(${customerCredits.remainingAmountCents}), 0)::integer` })
      .from(customerCredits)
      .where(and(eq(customerCredits.customerId, customer.id), eq(customerCredits.status, "active"))),
  ]);
  const ticketIds = ticketRows.map(({ ticket }) => ticket.id);
  const messageRows = ticketIds.length
    ? await db.select({ message: customerSupportMessages, author: users })
      .from(customerSupportMessages)
      .innerJoin(users, eq(users.id, customerSupportMessages.authorId))
      .where(inArray(customerSupportMessages.ticketId, ticketIds))
      .orderBy(customerSupportMessages.createdAt)
    : [];
  const messagesByTicket = new Map<string, CustomerSupportTicketView["messages"]>();
  for (const { message, author } of messageRows) {
    const list = messagesByTicket.get(message.ticketId) ?? [];
    list.push({
      id: message.id,
      authorRole: message.authorRole as "customer" | "admin",
      authorName: message.authorRole === "admin" ? "Send a Scout Support" : [author.firstName, author.lastName].filter(Boolean).join(" ") || "You",
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    });
    messagesByTicket.set(message.ticketId, list);
  }
  const seenBundles = new Set<string>();
  const missionOptions = missionRows.flatMap(({ mission, bundle }) => {
    if (mission.bundleId) {
      if (seenBundles.has(mission.bundleId) || mission.bundleSequence !== bundle?.activeSequence) return [];
      seenBundles.add(mission.bundleId);
    }
    return [{
      id: mission.id,
      title: bundle?.title ?? mission.title,
      label: `${missionStatus(bundle?.status ?? mission.status)} · ${mission.createdAt.toLocaleDateString()}`,
    }];
  }).slice(0, 25);
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Customer";
  return <CustomerDashboardShell active="support" name={name}>
    <div className="dash-welcome simple-title"><div><span className="kicker">Customer care</span><h1>Support center</h1><p>Open a ticket, talk with Support, and approve any refund or account-credit resolution.</p></div></div>
    <CustomerSupportCenter
      creditBalanceCents={Number(creditBalance?.total ?? 0)}
      missions={missionOptions}
      tickets={ticketRows.map(({ ticket, missionTitle }) => ({
        id: ticket.id,
        reason: ticket.reason as CustomerSupportReason,
        summary: ticket.summary,
        status: ticket.status as CustomerSupportTicketView["status"],
        missionId: ticket.missionId,
        missionTitle,
        resolutionType: ticket.resolutionType as CustomerSupportResolution | null,
        resolutionAmountCents: ticket.resolutionAmountCents,
        resolutionNote: ticket.resolutionNote,
        customerDecision: ticket.customerDecision,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        messages: messagesByTicket.get(ticket.id) ?? [],
      }))}
    />
  </CustomerDashboardShell>;
}

function missionStatus(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
