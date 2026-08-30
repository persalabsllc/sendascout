"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  customerCredits,
  customerSupportMessages,
  customerSupportTickets,
  missionBundles,
  missionCases,
  missions,
  users,
} from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import {
  CUSTOMER_SUPPORT_REASONS,
  customerSupportResolutionLabel,
  validSupportResolutionAmount,
  type CustomerSupportReason,
  type CustomerSupportResolution,
} from "@/lib/customer-support-core";
import { notifyUser } from "@/lib/notifications";

type Result = { ok: true } | { ok: false; error: string };
type CreateTicketInput = { reason: CustomerSupportReason; missionId: string; message: string };

function cleanMessage(value: string, label = "Message") {
  const message = value.trim();
  if (message.length < 10) throw new Error(`${label} must be at least 10 characters.`);
  if (message.length > 3000) throw new Error(`${label} is limited to 3,000 characters.`);
  return message;
}

function refreshSupport() {
  revalidatePath("/dashboard/customer/support");
  revalidatePath("/control-room");
  revalidatePath("/control-room/support");
}

async function notifySupportAdmins(input: { missionId: string | null; kind: string; title: string; body: string }) {
  try {
    const admins = await getDb().select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    await Promise.allSettled(admins.map((admin) => notifyUser({
      recipientUserId: admin.id,
      missionId: input.missionId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      actionLabel: "Open customer support",
      actionUrl: "https://sendascout.com/control-room/support",
    })));
  } catch (error) {
    console.warn("Customer support update saved, but administrator alerts could not be delivered", error);
  }
}

async function notifySupportCustomer(input: { customerId: string; missionId: string | null; kind: string; title: string; body: string; actionLabel: string }) {
  try {
    await notifyUser({
      recipientUserId: input.customerId,
      missionId: input.missionId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      actionLabel: input.actionLabel,
      actionUrl: "https://sendascout.com/dashboard/customer/support",
    });
  } catch (error) {
    console.warn("Customer support update saved, but the customer alert could not be delivered", error);
  }
}

export async function createCustomerSupportTicket(input: CreateTicketInput): Promise<Result> {
  try {
    const customer = await requireAppUser("customer");
    if (!CUSTOMER_SUPPORT_REASONS.includes(input.reason)) throw new Error("Choose a valid support reason.");
    const summary = cleanMessage(input.message, "Issue details");
    const missionId = input.missionId.trim() || null;
    const db = getDb();
    if (missionId) {
      const [mission] = await db.select({ id: missions.id }).from(missions)
        .where(and(eq(missions.id, missionId), eq(missions.customerId, customer.id)))
        .limit(1);
      if (!mission) throw new Error("Choose one of your recent or open missions.");
    }

    const ticketId = crypto.randomUUID();
    await db.batch([
      db.insert(customerSupportTickets).values({
        id: ticketId,
        customerId: customer.id,
        missionId,
        reason: input.reason,
        summary,
      }),
      db.insert(customerSupportMessages).values({
        ticketId,
        authorId: customer.id,
        authorRole: "customer",
        body: summary,
      }),
    ]);
    await notifySupportAdmins({ missionId, kind: "customer_support_opened", title: "New customer support ticket", body: "A customer opened a support ticket for Control Room review." });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to open the support ticket." };
  }
}

export async function customerReplyToSupport(ticketId: string, message: string): Promise<Result> {
  try {
    const customer = await requireAppUser("customer");
    const body = cleanMessage(message);
    const db = getDb();
    const [ticket] = await db.select().from(customerSupportTickets)
      .where(and(eq(customerSupportTickets.id, ticketId), eq(customerSupportTickets.customerId, customer.id)))
      .limit(1);
    if (!ticket) throw new Error("Support ticket not found.");
    if (ticket.status === "closed") throw new Error("This ticket is already closed.");
    const now = new Date();
    await db.batch([
      db.insert(customerSupportMessages).values({ ticketId, authorId: customer.id, authorRole: "customer", body }),
      db.update(customerSupportTickets).set({
        status: "open",
        customerDecision: ticket.status === "awaiting_customer" ? "needs_review" : ticket.customerDecision,
        customerDecisionNote: ticket.status === "awaiting_customer" ? body : ticket.customerDecisionNote,
        decidedAt: ticket.status === "awaiting_customer" ? now : ticket.decidedAt,
        updatedAt: now,
      }).where(and(eq(customerSupportTickets.id, ticketId), eq(customerSupportTickets.customerId, customer.id))),
    ]);
    await notifySupportAdmins({ missionId: ticket.missionId, kind: "customer_support_customer_reply", title: "Customer replied to Support", body: ticket.status === "awaiting_customer" ? "A customer requested another review of a proposed resolution." : "A customer added information to an open support ticket." });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to send your reply." };
  }
}

export async function adminReplyToCustomerSupport(ticketId: string, message: string): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const body = cleanMessage(message, "Reply");
    const db = getDb();
    const [ticket] = await db.select().from(customerSupportTickets).where(eq(customerSupportTickets.id, ticketId)).limit(1);
    if (!ticket) throw new Error("Support ticket not found.");
    if (ticket.status === "closed") throw new Error("This ticket is already closed.");
    await db.batch([
      db.insert(customerSupportMessages).values({ ticketId, authorId: admin.id, authorRole: "admin", body }),
      db.update(customerSupportTickets).set({ updatedAt: new Date() }).where(eq(customerSupportTickets.id, ticketId)),
    ]);
    await notifySupportCustomer({
      customerId: ticket.customerId,
      missionId: ticket.missionId,
      kind: "customer_support_reply",
      title: "Support replied to your ticket",
      body: "Send a Scout support added a response to your customer ticket.",
      actionLabel: "View support ticket",
    });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to send the support reply." };
  }
}

export async function adminProposeCustomerSupportResolution(
  ticketId: string,
  resolution: CustomerSupportResolution,
  amountCents: number,
  note: string,
): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    if (!["full_refund", "partial_refund", "account_credit"].includes(resolution)) throw new Error("Choose a valid resolution.");
    const resolutionNote = cleanMessage(note, "Resolution note");
    const db = getDb();
    const [item] = await db.select({ ticket: customerSupportTickets, mission: missions, bundle: missionBundles })
      .from(customerSupportTickets)
      .leftJoin(missions, eq(missions.id, customerSupportTickets.missionId))
      .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
      .where(eq(customerSupportTickets.id, ticketId))
      .limit(1);
    if (!item || item.ticket.status === "closed") throw new Error("This support ticket is no longer open.");
    if ((resolution === "full_refund" || resolution === "partial_refund") && !item.mission) {
      throw new Error("Refund resolutions require a mission on the support ticket.");
    }

    const missionPriceCents = item.bundle?.customerPriceCents ?? item.mission?.customerPriceCents ?? 0;
    let previouslyRecordedRefundCents = 0;
    if (item.mission) {
      const missionScope = item.bundle
        ? eq(missions.bundleId, item.bundle.id)
        : eq(missions.id, item.mission.id);
      const [[supportRefunds], [caseRefunds]] = await Promise.all([
        db.select({ total: sql<number>`COALESCE(SUM(${customerSupportTickets.resolutionAmountCents}), 0)::integer` })
          .from(customerSupportTickets)
          .innerJoin(missions, eq(missions.id, customerSupportTickets.missionId))
          .where(and(
            eq(customerSupportTickets.status, "closed"),
            eq(customerSupportTickets.customerDecision, "approved"),
            inArray(customerSupportTickets.resolutionType, ["full_refund", "partial_refund"]),
            missionScope,
          )),
        db.select({ total: sql<number>`COALESCE(SUM(${missionCases.refundAmountCents}), 0)::integer` })
          .from(missionCases)
          .innerJoin(missions, eq(missions.id, missionCases.missionId))
          .where(and(eq(missionCases.status, "resolved"), missionScope)),
      ]);
      previouslyRecordedRefundCents = Number(supportRefunds?.total ?? 0) + Number(caseRefunds?.total ?? 0);
    }
    const remainingRefundableCents = Math.max(0, missionPriceCents - previouslyRecordedRefundCents);
    const maximumCreditCents = item.mission ? Math.max(1, missionPriceCents) : 50_000;
    const finalAmountCents = validSupportResolutionAmount(resolution, amountCents, remainingRefundableCents, maximumCreditCents);
    if (finalAmountCents === null) {
      if (resolution === "full_refund" || resolution === "partial_refund") {
        throw new Error(`Enter an amount within the remaining refundable balance of $${(remainingRefundableCents / 100).toFixed(2)}.`);
      }
      throw new Error(`Enter a credit between $0.01 and $${(maximumCreditCents / 100).toFixed(2)}.`);
    }

    const now = new Date();
    const proposalMessage = `${customerSupportResolutionLabel(resolution)} proposed for $${(finalAmountCents / 100).toFixed(2)}. Customer approval is required before this ticket closes.`;
    await db.batch([
      db.update(customerSupportTickets).set({
        status: "awaiting_customer",
        resolutionType: resolution,
        resolutionAmountCents: finalAmountCents,
        resolutionNote,
        proposedBy: admin.id,
        proposedAt: now,
        customerDecision: null,
        customerDecisionNote: null,
        decidedAt: null,
        updatedAt: now,
      }).where(and(eq(customerSupportTickets.id, ticketId), inArray(customerSupportTickets.status, ["open", "awaiting_customer"]))),
      db.insert(customerSupportMessages).values({ ticketId, authorId: admin.id, authorRole: "admin", body: proposalMessage }),
    ]);
    await notifySupportCustomer({
      customerId: item.ticket.customerId,
      missionId: item.ticket.missionId,
      kind: "customer_support_resolution",
      title: "Your support resolution is ready",
      body: `${customerSupportResolutionLabel(resolution)} of $${(finalAmountCents / 100).toFixed(2)} is ready for your review and approval.`,
      actionLabel: "Review resolution",
    });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to propose the resolution." };
  }
}

export async function customerAcceptSupportResolution(ticketId: string): Promise<Result> {
  try {
    const customer = await requireAppUser("customer");
    const db = getDb();
    const [ticket] = await db.select().from(customerSupportTickets)
      .where(and(eq(customerSupportTickets.id, ticketId), eq(customerSupportTickets.customerId, customer.id)))
      .limit(1);
    if (!ticket || ticket.status !== "awaiting_customer" || !ticket.resolutionType || ticket.resolutionAmountCents <= 0) {
      throw new Error("This resolution is no longer awaiting approval.");
    }
    const now = new Date();
    await db.execute(sql`
      WITH approved_ticket AS (
        UPDATE customer_support_tickets
        SET status = 'closed', customer_decision = 'approved', customer_decision_note = NULL,
            decided_at = ${now}, closed_at = ${now}, updated_at = ${now}
        WHERE id = ${ticketId} AND customer_id = ${customer.id} AND status = 'awaiting_customer'
        RETURNING id, customer_id, resolution_type, resolution_amount_cents
      ), issued_credit AS (
        INSERT INTO customer_credits (customer_id, ticket_id, amount_cents, remaining_amount_cents, status, created_at, updated_at)
        SELECT customer_id, id, resolution_amount_cents, resolution_amount_cents, 'active', ${now}, ${now}
        FROM approved_ticket
        WHERE resolution_type = 'account_credit'
        ON CONFLICT (ticket_id) DO NOTHING
        RETURNING id
      )
      SELECT COUNT(*) FROM approved_ticket
    `);
    const [closed] = await db.select({ status: customerSupportTickets.status, decision: customerSupportTickets.customerDecision })
      .from(customerSupportTickets)
      .where(and(eq(customerSupportTickets.id, ticketId), eq(customerSupportTickets.customerId, customer.id)))
      .limit(1);
    if (closed?.status !== "closed" || closed.decision !== "approved") throw new Error("The ticket changed before approval. Refresh and try again.");
    await notifySupportAdmins({ missionId: ticket.missionId, kind: "customer_support_approved", title: "Customer approved the support resolution", body: "The customer accepted the proposed resolution and the ticket closed." });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to approve the resolution." };
  }
}
