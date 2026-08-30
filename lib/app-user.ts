import { auth, currentUser } from "@clerk/nextjs/server";
import { eq, or } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { hasCurrentLegalAcceptance } from "@/lib/legal";

export type AppRole = "customer" | "scout" | "admin";

export async function requireAuthenticatedAppUser(preferredRole: AppRole = "customer") {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!clerkUser || !email) throw new Error("Your account needs a verified email address.");

  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(or(eq(users.clerkUserId, userId), eq(users.email, email)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        clerkUserId: userId,
        email,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      clerkUserId: userId,
      role: preferredRole,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      email,
    })
    .returning();

  return created;
}

export async function requireAppUser(preferredRole: AppRole = "customer") {
  const user = await requireAuthenticatedAppUser(preferredRole);
  if (!hasCurrentLegalAcceptance(user)) redirect("/legal/accept");
  return user;
}

export async function requireAdminUser() {
  const user = await requireAppUser("admin");
  const configuredAdmins = (process.env.SENDASCOUT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (user.role !== "admin" && !configuredAdmins.includes(user.email.toLowerCase())) {
    throw new Error("This account does not have Send a Scout administrator access.");
  }

  if (user.role !== "admin") {
    const [admin] = await getDb()
      .update(users)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return admin;
  }

  return user;
}
