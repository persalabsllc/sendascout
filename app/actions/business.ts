"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { businessAccounts, businessMembers, customerSavedLocations, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export type BusinessMemberRole = "owner" | "admin" | "requester" | "viewer";
export type BusinessAssignableRole = Exclude<BusinessMemberRole, "owner">;

export type BusinessLocationInput = {
  businessAccountId: string;
  label: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
};

export type BusinessActionResult = { ok: true } | { ok: false; error: string };

class BusinessActionError extends Error {}

function required(value: string, label: string, maximumLength: number) {
  const normalized = value.trim();
  if (!normalized) throw new BusinessActionError(`${label} is required.`);
  if (normalized.length > maximumLength) throw new BusinessActionError(`${label} is too long.`);
  return normalized;
}

function optional(value: string, maximumLength: number) {
  const normalized = value.trim();
  if (normalized.length > maximumLength) throw new BusinessActionError("One of the optional fields is too long.");
  return normalized || null;
}

function validId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BusinessActionError("That business record could not be verified.");
  }
}

function assertCustomer(role: string) {
  if (role !== "customer") throw new BusinessActionError("Business accounts are available to customer accounts.");
}

function actionFailure(error: unknown, fallback: string): BusinessActionResult {
  if (error instanceof BusinessActionError) return { ok: false, error: error.message };
  console.error(fallback, error);
  return { ok: false, error: fallback };
}

function revalidateBusinessAccount() {
  revalidatePath("/dashboard/customer/business");
  revalidatePath("/dashboard/customer");
}

async function getBusinessAccess(userId: string, businessAccountId: string) {
  validId(businessAccountId);
  const db = getDb();
  const [account] = await db
    .select({ id: businessAccounts.id, ownerUserId: businessAccounts.ownerUserId })
    .from(businessAccounts)
    .where(eq(businessAccounts.id, businessAccountId))
    .limit(1);

  if (!account) throw new BusinessActionError("That business account was not found.");
  if (account.ownerUserId === userId) return { account, role: "owner" as const };

  const [membership] = await db
    .select({ role: businessMembers.role })
    .from(businessMembers)
    .where(and(eq(businessMembers.businessAccountId, businessAccountId), eq(businessMembers.userId, userId)))
    .limit(1);

  if (!membership) throw new BusinessActionError("You do not have access to that business account.");
  if (!(["owner", "admin", "requester", "viewer"] as const).includes(membership.role as BusinessMemberRole)) {
    throw new BusinessActionError("That business membership has an unsupported role.");
  }
  return { account, role: membership.role as BusinessMemberRole };
}

async function requireBusinessManager(userId: string, businessAccountId: string) {
  const access = await getBusinessAccess(userId, businessAccountId);
  if (access.role !== "owner" && access.role !== "admin") {
    throw new BusinessActionError("Only business owners and administrators can make this change.");
  }
  return access;
}

export async function createBusinessAccount(nameInput: string): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    const name = required(nameInput, "Organization name", 120);
    const db = getDb();
    const [[ownedAccount], [membership]] = await Promise.all([
      db.select({ id: businessAccounts.id }).from(businessAccounts).where(eq(businessAccounts.ownerUserId, user.id)).limit(1),
      db.select({ id: businessMembers.id }).from(businessMembers).where(eq(businessMembers.userId, user.id)).limit(1),
    ]);
    if (ownedAccount || membership) throw new BusinessActionError("Your customer account is already connected to a business account.");

    const businessAccountId = randomUUID();
    await db.batch([
      db.insert(businessAccounts).values({ id: businessAccountId, ownerUserId: user.id, name }),
      db.insert(businessMembers).values({ businessAccountId, userId: user.id, role: "owner" }),
    ]);

    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not create your business account.");
  }
}

export async function saveBusinessAccountName(businessAccountId: string, nameInput: string): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    const name = required(nameInput, "Organization name", 120);
    await requireBusinessManager(user.id, businessAccountId);
    await getDb().update(businessAccounts).set({ name, updatedAt: new Date() }).where(eq(businessAccounts.id, businessAccountId));
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not update the organization name.");
  }
}

export async function addBusinessLocation(input: BusinessLocationInput): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    await requireBusinessManager(user.id, input.businessAccountId);
    const label = required(input.label, "Location label", 80);
    const addressLine1 = required(input.addressLine1, "Street address", 160);
    const addressLine2 = optional(input.addressLine2, 160);
    const city = required(input.city, "City", 100);
    const state = required(input.state, "State", 2).toUpperCase();
    const zip = required(input.zip, "ZIP code", 10);
    if (!/^[A-Z]{2}$/.test(state)) throw new BusinessActionError("Enter a two-letter state abbreviation.");
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new BusinessActionError("Enter a valid ZIP code.");

    await getDb().insert(customerSavedLocations).values({
      customerId: user.id,
      businessAccountId: input.businessAccountId,
      label,
      addressLine1,
      addressLine2,
      city,
      state,
      zip,
    });
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not save that business location.");
  }
}

export async function deleteBusinessLocation(businessAccountId: string, locationId: string): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    validId(locationId);
    await requireBusinessManager(user.id, businessAccountId);
    const [location] = await getDb()
      .select({ id: customerSavedLocations.id })
      .from(customerSavedLocations)
      .where(and(eq(customerSavedLocations.id, locationId), eq(customerSavedLocations.businessAccountId, businessAccountId)))
      .limit(1);
    if (!location) throw new BusinessActionError("That saved location was not found in this business account.");
    await getDb().delete(customerSavedLocations).where(eq(customerSavedLocations.id, locationId));
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not remove that business location.");
  }
}

export async function addBusinessMember(businessAccountId: string, emailInput: string, role: BusinessAssignableRole): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    const access = await requireBusinessManager(user.id, businessAccountId);
    const email = required(emailInput, "Email address", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BusinessActionError("Enter a valid email address.");
    if (!(["admin", "requester", "viewer"] as const).includes(role)) throw new BusinessActionError("Choose a valid team role.");
    if (role === "admin" && access.role !== "owner") throw new BusinessActionError("Only the business owner can add an administrator.");

    const db = getDb();
    const [memberUser] = await db
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!memberUser || memberUser.role !== "customer" || memberUser.status !== "active") {
      throw new BusinessActionError("No active Send a Scout customer account was found for that email.");
    }

    const [existing] = await db
      .select({ id: businessMembers.id })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessAccountId, businessAccountId), eq(businessMembers.userId, memberUser.id)))
      .limit(1);
    if (existing) throw new BusinessActionError("That customer is already on this business roster.");

    await db.insert(businessMembers).values({ businessAccountId, userId: memberUser.id, role });
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not add that team member.");
  }
}

export async function updateBusinessMemberRole(businessAccountId: string, memberId: string, role: BusinessAssignableRole): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    validId(memberId);
    const access = await requireBusinessManager(user.id, businessAccountId);
    if (!(["admin", "requester", "viewer"] as const).includes(role)) throw new BusinessActionError("Choose a valid team role.");

    const [member] = await getDb()
      .select({ userId: businessMembers.userId, role: businessMembers.role })
      .from(businessMembers)
      .where(and(eq(businessMembers.id, memberId), eq(businessMembers.businessAccountId, businessAccountId)))
      .limit(1);
    if (!member) throw new BusinessActionError("That team member was not found.");
    if (member.userId === user.id) throw new BusinessActionError("You cannot change your own business role here.");
    if (member.userId === access.account.ownerUserId || member.role === "owner") throw new BusinessActionError("The business owner role cannot be changed.");
    if (access.role !== "owner" && (member.role === "admin" || role === "admin")) {
      throw new BusinessActionError("Only the business owner can change an administrator role.");
    }

    await getDb().update(businessMembers).set({ role }).where(eq(businessMembers.id, memberId));
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not update that team member.");
  }
}

export async function removeBusinessMember(businessAccountId: string, memberId: string): Promise<BusinessActionResult> {
  const user = await requireAppUser("customer");
  try {
    assertCustomer(user.role);
    validId(memberId);
    const access = await requireBusinessManager(user.id, businessAccountId);
    const [member] = await getDb()
      .select({ userId: businessMembers.userId, role: businessMembers.role })
      .from(businessMembers)
      .where(and(eq(businessMembers.id, memberId), eq(businessMembers.businessAccountId, businessAccountId)))
      .limit(1);
    if (!member) throw new BusinessActionError("That team member was not found.");
    if (member.userId === user.id) throw new BusinessActionError("You cannot remove your own business access here.");
    if (member.userId === access.account.ownerUserId || member.role === "owner") throw new BusinessActionError("The business owner cannot be removed.");
    if (member.role === "admin" && access.role !== "owner") throw new BusinessActionError("Only the business owner can remove an administrator.");

    await getDb().delete(businessMembers).where(eq(businessMembers.id, memberId));
    revalidateBusinessAccount();
    return { ok: true };
  } catch (error) {
    return actionFailure(error, "We could not remove that team member.");
  }
}
