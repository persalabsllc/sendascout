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
import { getMissionRefundCapacity } from "@/lib/stripe-refund-capacity";
import { requestMissionRefund } from "@/lib/stripe-refunds";
import { openMissionCase } from "@/app/actions/operations";

type Result = { ok: true } | { ok: false; error: string };
type CreateTicketInput = { reason: CustomerSupportReason; missionId: string; message: string };

const TWO_PERSON_REFUND_THRESHOLD_CENTS = 10_000;

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
    const nominalRemainingRefundableCents = Math.max(0, missionPriceCents - previouslyRecordedRefundCents);
    const ledgerRefundableCents = item.mission
      ? (await getMissionRefundCapacity(item.mission.id)).refundableCents
      : 0;
    const remainingRefundableCents = Math.min(nominalRemainingRefundableCents, ledgerRefundableCents);
    const maximumCreditCents = item.mission ? Math.max(1, missionPriceCents) : 50_000;
    const finalAmountCents = validSupportResolutionAmount(resolution, amountCents, remainingRefundableCents, maximumCreditCents);
    if (finalAmountCents === null) {
      if (resolution === "full_refund" || resolution === "partial_refund") {
        throw new Error(`Enter an amount within the remaining refundable balance of $${(remainingRefundableCents / 100).toFixed(2)}.`);
      }
      throw new Error(`Enter a credit between $0.01 and $${(maximumCreditCents / 100).toFixed(2)}.`);
    }

    const now = new Date();
    const requiresFinancialApproval = ["full_refund", "partial_refund"].includes(resolution)
      && finalAmountCents > TWO_PERSON_REFUND_THRESHOLD_CENTS;
    const proposalMessage = requiresFinancialApproval
      ? `${customerSupportResolutionLabel(resolution)} proposed for $${(finalAmountCents / 100).toFixed(2)}. A distinct second administrator must approve this high-value refund before it is sent to the customer.`
      : `${customerSupportResolutionLabel(resolution)} proposed for $${(finalAmountCents / 100).toFixed(2)}. Customer approval is required before this ticket closes.`;
    await db.execute(sql`
      WITH proposed_ticket AS (
        UPDATE customer_support_tickets
        SET status = ${requiresFinancialApproval ? "open" : "awaiting_customer"},
            resolution_type = ${resolution},
            resolution_amount_cents = ${finalAmountCents},
            resolution_note = ${resolutionNote},
            proposed_by = ${admin.id},
            proposed_at = ${now},
            financial_approved_by = NULL,
            financial_approved_at = NULL,
            customer_decision = NULL,
            customer_decision_note = NULL,
            decided_at = NULL,
            updated_at = ${now}
        WHERE id = ${ticketId}
          AND status IN ('open', 'awaiting_customer')
          AND customer_decision IS DISTINCT FROM 'approved'
        RETURNING id
      ), recorded_message AS (
        INSERT INTO customer_support_messages (ticket_id, author_id, author_role, body)
        SELECT id, ${admin.id}, 'admin', ${proposalMessage}
        FROM proposed_ticket
        RETURNING id
      )
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM proposed_ticket) = 1
          AND (SELECT COUNT(*) FROM recorded_message) = 1
        THEN 1
        ELSE 1 / (
          (SELECT COUNT(*)::integer FROM proposed_ticket)
          - (SELECT COUNT(*)::integer FROM proposed_ticket)
        )
      END AS saved
    `);
    if (requiresFinancialApproval) {
      await notifySupportAdmins({
        missionId: item.ticket.missionId,
        kind: "customer_support_financial_review",
        title: "High-value refund needs a second review",
        body: `A refund of $${(finalAmountCents / 100).toFixed(2)} is waiting for a different administrator to approve it.`,
      });
    } else {
      await notifySupportCustomer({
        customerId: item.ticket.customerId,
        missionId: item.ticket.missionId,
        kind: "customer_support_resolution",
        title: "Your support resolution is ready",
        body: `${customerSupportResolutionLabel(resolution)} of $${(finalAmountCents / 100).toFixed(2)} is ready for your review and approval.`,
        actionLabel: "Review resolution",
      });
    }
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to propose the resolution." };
  }
}

export async function adminApproveCustomerSupportRefund(ticketId: string): Promise<Result> {
  try {
    const admin = await requireAdminUser();
    const db = getDb();
    const [ticket] = await db.select().from(customerSupportTickets)
      .where(eq(customerSupportTickets.id, ticketId))
      .limit(1);
    if (!ticket
      || ticket.status !== "open"
      || !ticket.proposedBy
      || !ticket.resolutionType
      || !["full_refund", "partial_refund"].includes(ticket.resolutionType)
      || ticket.resolutionAmountCents <= TWO_PERSON_REFUND_THRESHOLD_CENTS
      || ticket.financialApprovedBy) {
      throw new Error("This ticket is not waiting for a second financial review.");
    }
    if (ticket.proposedBy === admin.id) {
      throw new Error("A different administrator must approve this high-value refund.");
    }
    const now = new Date();
    const approvalMessage = `A distinct second administrator approved the proposed ${customerSupportResolutionLabel(ticket.resolutionType as CustomerSupportResolution).toLowerCase()} of $${(ticket.resolutionAmountCents / 100).toFixed(2)}. It is now ready for customer review.`;
    await db.execute(sql`
      WITH approved_ticket AS (
        UPDATE customer_support_tickets
        SET status = 'awaiting_customer',
            financial_approved_by = ${admin.id},
            financial_approved_at = ${now},
            updated_at = ${now}
        WHERE id = ${ticketId}
          AND status = 'open'
          AND proposed_by = ${ticket.proposedBy}
          AND proposed_by <> ${admin.id}
          AND financial_approved_by IS NULL
          AND resolution_type = ${ticket.resolutionType}
          AND resolution_amount_cents = ${ticket.resolutionAmountCents}
        RETURNING id, customer_id, mission_id
      ), recorded_message AS (
        INSERT INTO customer_support_messages (ticket_id, author_id, author_role, body)
        SELECT id, ${admin.id}, 'admin', ${approvalMessage}
        FROM approved_ticket
        RETURNING id
      )
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM approved_ticket) = 1
          AND (SELECT COUNT(*) FROM recorded_message) = 1
        THEN 1
        ELSE 1 / (
          (SELECT COUNT(*)::integer FROM approved_ticket)
          - (SELECT COUNT(*)::integer FROM approved_ticket)
        )
      END AS saved
    `);
    await notifySupportCustomer({
      customerId: ticket.customerId,
      missionId: ticket.missionId,
      kind: "customer_support_resolution",
      title: "Your support resolution is ready",
      body: `${customerSupportResolutionLabel(ticket.resolutionType as CustomerSupportResolution)} of $${(ticket.resolutionAmountCents / 100).toFixed(2)} is ready for your review and approval.`,
      actionLabel: "Review resolution",
    });
    refreshSupport();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to approve the refund." };
  }
}

async function supportRefundMissionCase(missionId: string, ticketId: string) {
  const db = getDb();
  const [scope] = await db.select({ mission: missions, bundle: missionBundles })
    .from(missions)
    .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!scope) throw new Error("The mission linked to this refund no longer exists.");
  if (scope.mission.archivedAt) {
    throw new Error("Control Room must reopen this archived mission record before issuing its refund.");
  }
  const caseScope = scope.bundle
    ? eq(missions.bundleId, scope.bundle.id)
    : eq(missionCases.missionId, scope.mission.id);
  const findOpenCase = async () => {
    const [openCase] = await db.select({ id: missionCases.id })
      .from(missionCases)
      .innerJoin(missions, eq(missions.id, missionCases.missionId))
      .where(and(eq(missionCases.status, "open"), caseScope))
      .limit(1);
    return openCase ?? null;
  };
  const existing = await findOpenCase();
  if (existing) return existing.id;
  const targetMissionId = scope.bundle
    ? (await db.select({ id: missions.id }).from(missions).where(and(
      eq(missions.bundleId, scope.bundle.id),
      eq(missions.bundleSequence, scope.bundle.activeSequence),
    )).limit(1))[0]?.id
    : scope.mission.id;
  if (!targetMissionId) throw new Error("The active itinerary part could not be found for financial review.");
  const opened = await openMissionCase(
    targetMissionId,
    "customer_problem",
    `Customer approved the refund proposed in support ticket ${ticketId.slice(0, 8).toUpperCase()}. Pause work and record the customer refund and explicit Scout payout outcome.`,
  );
  if (!opened.ok) throw new Error(opened.error);
  const created = await findOpenCase();
  if (!created) throw new Error("The financial review case could not be confirmed after pausing the mission.");
  return created.id;
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
    const isRefund = ["full_refund", "partial_refund"].includes(ticket.resolutionType);
    if (isRefund
      && ticket.resolutionAmountCents > TWO_PERSON_REFUND_THRESHOLD_CENTS
      && (!ticket.financialApprovedBy || ticket.financialApprovedBy === ticket.proposedBy)) {
      throw new Error("This high-value refund has not completed its required second-administrator review.");
    }
    const now = new Date();
    if (isRefund) {
      const [claimed] = await db.update(customerSupportTickets).set({
        customerDecision: "approved",
        customerDecisionNote: null,
        decidedAt: now,
        updatedAt: now,
      }).where(and(
        eq(customerSupportTickets.id, ticketId),
        eq(customerSupportTickets.customerId, customer.id),
        eq(customerSupportTickets.status, "awaiting_customer"),
        eq(customerSupportTickets.resolutionType, ticket.resolutionType),
        eq(customerSupportTickets.resolutionAmountCents, ticket.resolutionAmountCents),
        ticket.proposedBy ? eq(customerSupportTickets.proposedBy, ticket.proposedBy) : sql`${customerSupportTickets.proposedBy} IS NULL`,
        ticket.financialApprovedBy
          ? eq(customerSupportTickets.financialApprovedBy, ticket.financialApprovedBy)
          : sql`${customerSupportTickets.financialApprovedBy} IS NULL`,
        sql`${customerSupportTickets.customerDecision} IS NULL OR ${customerSupportTickets.customerDecision} = 'approved'`,
      )).returning({ id: customerSupportTickets.id });
      if (!claimed && ticket.customerDecision !== "approved") {
        throw new Error("The resolution changed before approval. Refresh and review it again.");
      }
      if (!claimed) {
        const [current] = await db.select().from(customerSupportTickets)
          .where(and(eq(customerSupportTickets.id, ticketId), eq(customerSupportTickets.customerId, customer.id)))
          .limit(1);
        if (!current
          || current.status !== "awaiting_customer"
          || current.customerDecision !== "approved"
          || current.resolutionType !== ticket.resolutionType
          || current.resolutionAmountCents !== ticket.resolutionAmountCents
          || current.proposedBy !== ticket.proposedBy
          || current.financialApprovedBy !== ticket.financialApprovedBy) {
          throw new Error("The resolution changed before approval. Refresh and review it again.");
        }
      }
      try {
        if (!ticket.missionId) throw new Error("Refund resolutions require a mission.");
        const missionCaseId = await supportRefundMissionCase(ticket.missionId, ticket.id);
        const refundResult = await requestMissionRefund({
          missionId: ticket.missionId,
          amountCents: ticket.resolutionAmountCents,
          idempotencyKey: `support-ticket:${ticket.id}:refund:v1`,
          missionCaseId,
          reason: `support-ticket:${ticket.id}`,
        });
        if (refundResult.refundRequestedCents !== ticket.resolutionAmountCents
          || refundResult.refundFailedCents > 0) {
          throw new Error("The refund could not be submitted against the original charge. Control Room review is required.");
        }
      } catch (error) {
        await db.update(customerSupportTickets).set({
          status: "open",
          customerDecision: "needs_review",
          customerDecisionNote: "The refund could not be reserved against the original charge. Control Room review is required.",
          updatedAt: new Date(),
        }).where(and(
          eq(customerSupportTickets.id, ticketId),
          eq(customerSupportTickets.status, "awaiting_customer"),
          eq(customerSupportTickets.customerDecision, "approved"),
        ));
        throw error;
      }
    }
    await db.execute(sql`
      WITH approved_ticket AS (
        UPDATE customer_support_tickets
        SET status = 'closed', customer_decision = 'approved', customer_decision_note = NULL,
            decided_at = COALESCE(decided_at, ${now}), closed_at = ${now}, updated_at = ${now}
        WHERE id = ${ticketId}
          AND customer_id = ${customer.id}
          AND status = 'awaiting_customer'
          AND resolution_type = ${ticket.resolutionType}
          AND resolution_amount_cents = ${ticket.resolutionAmountCents}
          AND (${!isRefund} OR customer_decision = 'approved')
        RETURNING id, customer_id, resolution_type, resolution_amount_cents
      ), issued_credit AS (
        INSERT INTO customer_credits (customer_id, ticket_id, amount_cents, remaining_amount_cents, status, created_at, updated_at)
        SELECT customer_id, id, resolution_amount_cents, resolution_amount_cents, 'active', ${now}, ${now}
        FROM approved_ticket
        WHERE resolution_type = 'account_credit'
        ON CONFLICT (ticket_id) DO NOTHING
        RETURNING id
      )
      SELECT CASE
        WHEN (SELECT COUNT(*) FROM approved_ticket) = 1 THEN 1
        ELSE 1 / (
          (SELECT COUNT(*)::integer FROM approved_ticket)
          - (SELECT COUNT(*)::integer FROM approved_ticket)
        )
      END AS saved
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
