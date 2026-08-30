import { and, asc, desc, eq } from "drizzle-orm";
import { BusinessAccountManager, type BusinessAccountView, type BusinessMemberView } from "@/components/business-account-manager";
import { CustomerDashboardShell } from "@/components/customer-dashboard-shell";
import { getDb } from "@/db";
import { businessAccounts, businessMembers, customerSavedLocations, users } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import type { BusinessMemberRole } from "@/app/actions/business";

export const metadata = { title: "Business Account | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerBusinessPage() {
  const user = await requireAppUser("customer");
  const db = getDb();
  const [ownedAccount] = await db
    .select({
      id: businessAccounts.id,
      name: businessAccounts.name,
      ownerUserId: businessAccounts.ownerUserId,
    })
    .from(businessAccounts)
    .where(eq(businessAccounts.ownerUserId, user.id))
    .orderBy(desc(businessAccounts.createdAt))
    .limit(1);

  let accountRecord = ownedAccount;
  let currentRole: BusinessMemberRole = "owner";

  if (!accountRecord) {
    const [membership] = await db
      .select({
        id: businessAccounts.id,
        name: businessAccounts.name,
        ownerUserId: businessAccounts.ownerUserId,
        role: businessMembers.role,
      })
      .from(businessMembers)
      .innerJoin(businessAccounts, eq(businessAccounts.id, businessMembers.businessAccountId))
      .where(eq(businessMembers.userId, user.id))
      .orderBy(desc(businessAccounts.createdAt))
      .limit(1);
    if (membership) {
      accountRecord = { id: membership.id, name: membership.name, ownerUserId: membership.ownerUserId };
      currentRole = normalizeRole(membership.role);
    }
  }

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer";
  if (!accountRecord) {
    return <CustomerDashboardShell active="business" name={name}>
      <div className="dash-welcome simple-title"><div><span className="kicker">Customer workspace</span><h1>Business account</h1><p>Create an organization record for shared locations and team access.</p></div></div>
      <BusinessAccountManager account={null} key="new-business-account" locations={[]} members={[]} />
    </CustomerDashboardShell>;
  }

  const [locationRows, memberRows, [owner]] = await Promise.all([
    db
      .select({
        id: customerSavedLocations.id,
        label: customerSavedLocations.label,
        addressLine1: customerSavedLocations.addressLine1,
        addressLine2: customerSavedLocations.addressLine2,
        city: customerSavedLocations.city,
        state: customerSavedLocations.state,
        zip: customerSavedLocations.zip,
      })
      .from(customerSavedLocations)
      .where(eq(customerSavedLocations.businessAccountId, accountRecord.id))
      .orderBy(asc(customerSavedLocations.label)),
    db
      .select({
        id: businessMembers.id,
        userId: businessMembers.userId,
        role: businessMembers.role,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(businessMembers)
      .innerJoin(users, eq(users.id, businessMembers.userId))
      .where(eq(businessMembers.businessAccountId, accountRecord.id))
      .orderBy(asc(businessMembers.createdAt)),
    db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users)
      .where(and(eq(users.id, accountRecord.ownerUserId), eq(users.status, "active")))
      .limit(1),
  ]);

  const members: BusinessMemberView[] = memberRows.map((member) => ({
    id: member.id,
    name: displayName(member.firstName, member.lastName, member.email),
    email: member.email,
    role: member.userId === accountRecord.ownerUserId ? "owner" : normalizeRole(member.role),
    isCurrentUser: member.userId === user.id,
  }));

  if (owner && !memberRows.some((member) => member.userId === owner.id)) {
    members.unshift({
      id: null,
      name: displayName(owner.firstName, owner.lastName, owner.email),
      email: owner.email,
      role: "owner",
      isCurrentUser: owner.id === user.id,
    });
  }

  members.sort((left, right) => Number(right.role === "owner") - Number(left.role === "owner") || left.name.localeCompare(right.name));
  const account: BusinessAccountView = {
    id: accountRecord.id,
    name: accountRecord.name,
    role: currentRole,
    canManage: currentRole === "owner" || currentRole === "admin",
  };

  return <CustomerDashboardShell active="business" name={name}>
    <div className="dash-welcome simple-title"><div><span className="kicker">Customer workspace</span><h1>{accountRecord.name}</h1><p>Maintain your organization, shared addresses and active team roster.</p></div></div>
    <BusinessAccountManager account={account} key={account.id} locations={locationRows} members={members} />
  </CustomerDashboardShell>;
}

function normalizeRole(role: string): BusinessMemberRole {
  if (role === "owner" || role === "admin" || role === "requester") return role;
  return "viewer";
}

function displayName(firstName: string | null, lastName: string | null, email: string) {
  return [firstName, lastName].filter(Boolean).join(" ") || email;
}
