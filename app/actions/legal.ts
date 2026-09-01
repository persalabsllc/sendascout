"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { legalAcceptances, users } from "@/db/schema";
import { requireAuthenticatedAppUser } from "@/lib/app-user";
import { LEGAL_VERSION, POLICIES_VERSION, PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";
import { tryAutoApproveScout } from "@/lib/scout-auto-approval";

export async function acceptLegalTerms(formData: FormData) {
  const user = await requireAuthenticatedAppUser("customer");
  if (formData.get("agreements") !== "accepted" || formData.get("arbitration") !== "accepted") {
    throw new Error("You must accept both agreements before using Send a Scout.");
  }

  const requestHeaders = await headers();
  const now = new Date();
  const db = getDb();
  await db.batch([
    db.insert(legalAcceptances).values({
      userId: user.id,
      role: user.role,
      legalVersion: LEGAL_VERSION,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      policiesVersion: POLICIES_VERSION,
      arbitrationAccepted: true,
      electronicRecordsAccepted: true,
      userAgent: requestHeaders.get("user-agent")?.slice(0, 500) ?? null,
      acceptedAt: now,
    }).onConflictDoNothing(),
    db.update(users).set({ legalVersion: LEGAL_VERSION, legalAcceptedAt: now, updatedAt: now }).where(eq(users.id, user.id)),
  ]);
  if (user.role === "scout") await tryAutoApproveScout(user.id);

  redirect(user.role === "scout" ? "/dashboard/scout" : user.role === "admin" ? "/control-room" : "/dashboard/customer");
}
