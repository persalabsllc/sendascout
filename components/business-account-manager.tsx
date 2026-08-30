"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  IconBuildingStore,
  IconCheck,
  IconInfoCircle,
  IconMapPin,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import {
  addBusinessLocation,
  addBusinessMember,
  createBusinessAccount,
  deleteBusinessLocation,
  removeBusinessMember,
  saveBusinessAccountName,
  updateBusinessMemberRole,
  type BusinessActionResult,
  type BusinessAssignableRole,
  type BusinessLocationInput,
  type BusinessMemberRole,
} from "@/app/actions/business";

export type BusinessAccountView = {
  id: string;
  name: string;
  role: BusinessMemberRole;
  canManage: boolean;
};

export type BusinessLocationView = {
  id: string;
  label: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  zip: string;
};

export type BusinessMemberView = {
  id: string | null;
  name: string;
  email: string;
  role: BusinessMemberRole;
  isCurrentUser: boolean;
};

type NoticeScope = "account" | "location" | "member";
type Notice = { kind: "success" | "error"; scope: NoticeScope; text: string } | null;

const emptyLocation = (businessAccountId: string): BusinessLocationInput => ({
  businessAccountId,
  label: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
});

export function BusinessAccountManager({
  account,
  locations,
  members,
}: {
  account: BusinessAccountView | null;
  locations: BusinessLocationView[];
  members: BusinessMemberView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [accountName, setAccountName] = useState(account?.name ?? "");
  const [location, setLocation] = useState<BusinessLocationInput>(emptyLocation(account?.id ?? ""));
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<BusinessAssignableRole>("requester");
  const [memberRoles, setMemberRoles] = useState<Record<string, BusinessMemberRole>>(() => Object.fromEntries(members.flatMap((member) => member.id ? [[member.id, member.role]] : [])));

  function perform(task: () => Promise<BusinessActionResult>, success: string, scope: NoticeScope, afterSuccess?: () => void, afterFailure?: () => void) {
    setNotice(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        afterFailure?.();
        setNotice({ kind: "error", scope, text: result.error });
        return;
      }
      afterSuccess?.();
      setNotice({ kind: "success", scope, text: success });
      router.refresh();
    });
  }

  if (!account) {
    return <>
      <section className="dash-section settings-section">
        <div className="dash-section-title"><div><h2>Create an organization</h2><p>Set up a shared name, location book and team roster for your customer account.</p></div></div>
        <form className="settings-form" onSubmit={(event) => {
          event.preventDefault();
          perform(() => createBusinessAccount(accountName), "Your business account is ready.", "account");
        }}>
          <label className="field"><span>Organization name</span><input autoComplete="organization" maxLength={120} onChange={(event) => setAccountName(event.target.value)} placeholder="Acme Property Group" required value={accountName} /></label>
          <p className="form-lede">This creates an organization record only. Billing plans, volume pricing and team email invitations are not active.</p>
          {notice?.scope === "account" && <NoticeMessage notice={notice} />}
          <button className="button" disabled={pending} type="submit">{pending ? "Creating…" : "Create business account"}{!pending && <IconBuildingStore size={18} />}</button>
        </form>
      </section>
      <div className="empty-prompt"><span><IconInfoCircle size={30} /></span><div><h3>A practical business foundation</h3><p>After setup, owners and administrators can maintain shared locations and add teammates who already have active customer accounts.</p></div></div>
    </>;
  }

  const canAssignAdmin = account.role === "owner";
  const accountId = account.id;
  const setLocationField = <K extends keyof BusinessLocationInput>(key: K, value: BusinessLocationInput[K]) => setLocation((current) => ({ ...current, [key]: value }));

  function submitLocation(event: FormEvent) {
    event.preventDefault();
    perform(() => addBusinessLocation({ ...location, businessAccountId: accountId }), "The shared location was saved.", "location", () => setLocation(emptyLocation(accountId)));
  }

  function submitMember(event: FormEvent) {
    event.preventDefault();
    perform(() => addBusinessMember(accountId, memberEmail, memberRole), "The customer was added to your team.", "member", () => {
      setMemberEmail("");
      setMemberRole("requester");
    });
  }

  return <>
    <section className="dash-section settings-section">
      <div className="dash-section-title"><div><h2>Organization</h2><p>Your shared business identity inside Send a Scout.</p></div><span className="status">{roleLabel(account.role)}</span></div>
      <form className="settings-form" onSubmit={(event) => {
        event.preventDefault();
        perform(() => saveBusinessAccountName(account.id, accountName), "The organization name was updated.", "account");
      }}>
        <label className="field"><span>Organization name</span><input autoComplete="organization" disabled={!account.canManage || pending} maxLength={120} onChange={(event) => setAccountName(event.target.value)} required value={accountName} /></label>
        {!account.canManage && <p className="form-lede">You have view-only access. A business owner or administrator can update organization settings.</p>}
        {notice?.scope === "account" && <NoticeMessage notice={notice} />}
        {account.canManage && <button className="button" disabled={pending || accountName.trim() === account.name} type="submit">{pending ? "Saving…" : "Save organization"}{!pending && <IconCheck size={18} />}</button>}
      </form>
    </section>

    <section className="dash-section settings-section">
      <div className="dash-section-title"><div><h2>Shared locations</h2><p>Reusable business addresses for your team. Mission forms can integrate these records separately.</p></div><span className="status">{locations.length} saved</span></div>
      {locations.length ? <div className="mission-list">{locations.map((item) => <article className="mission-list-row" key={item.id}>
        <span className="list-icon"><IconMapPin size={21} /></span>
        <div className="list-main"><small>Business location</small><strong>{item.label}</strong><span>{formatAddress(item)}</span></div>
        <div className="list-meta"><span className="status muted-status">Shared</span>{account.canManage && <button aria-label={`Remove ${item.label}`} className="claim-button" disabled={pending} onClick={() => {
          if (!window.confirm(`Remove ${item.label} from shared locations?`)) return;
          perform(() => deleteBusinessLocation(account.id, item.id), "The shared location was removed.", "location");
        }} type="button"><IconTrash size={15} /></button>}</div>
        <span />
      </article>)}</div> : <div className="dashboard-empty"><IconMapPin size={31} /><h3>No shared locations yet</h3><p>Add offices, job sites or other addresses your team uses repeatedly.</p></div>}
      {account.canManage && <form className="settings-form" onSubmit={submitLocation}>
        <div className="profile-address-label"><IconPlus size={17} /><div><strong>Add shared location</strong><span>Store the address as entered; it is not route-verified here.</span></div></div>
        <label className="field"><span>Location label</span><input maxLength={80} onChange={(event) => setLocationField("label", event.target.value)} placeholder="Downtown office" required value={location.label} /></label>
        <label className="field"><span>Street address</span><input autoComplete="address-line1" maxLength={160} onChange={(event) => setLocationField("addressLine1", event.target.value)} required value={location.addressLine1} /></label>
        <label className="field"><span>Suite, unit, etc. (optional)</span><input autoComplete="address-line2" maxLength={160} onChange={(event) => setLocationField("addressLine2", event.target.value)} value={location.addressLine2} /></label>
        <div className="profile-location-row">
          <label className="field"><span>City</span><input autoComplete="address-level2" maxLength={100} onChange={(event) => setLocationField("city", event.target.value)} required value={location.city} /></label>
          <label className="field"><span>State</span><input autoComplete="address-level1" maxLength={2} onChange={(event) => setLocationField("state", event.target.value.toUpperCase())} required value={location.state} /></label>
          <label className="field"><span>ZIP code</span><input autoComplete="postal-code" inputMode="numeric" maxLength={10} onChange={(event) => setLocationField("zip", event.target.value)} required value={location.zip} /></label>
        </div>
        {notice?.scope === "location" && <NoticeMessage notice={notice} />}
        <button className="button" disabled={pending} type="submit">{pending ? "Saving…" : "Add location"}{!pending && <IconPlus size={18} />}</button>
      </form>}
    </section>

    <section className="dash-section settings-section">
      <div className="dash-section-title"><div><h2>Team roster</h2><p>Direct access for people who already have active Send a Scout customer accounts.</p></div><span className="status">{members.length} member{members.length === 1 ? "" : "s"}</span></div>
      <div className="mission-list">{members.map((member) => {
        const editable = account.canManage && Boolean(member.id) && !member.isCurrentUser && member.role !== "owner" && (account.role === "owner" || member.role !== "admin");
        const selectedRole = member.id ? memberRoles[member.id] ?? member.role : member.role;
        return <article className="mission-list-row" key={member.id ?? `owner-${member.email}`}>
          <span className="list-icon"><IconUsers size={21} /></span>
          <div className="list-main"><small>{member.isCurrentUser ? "You" : "Team member"}</small><strong>{member.name}</strong><span>{member.email}</span></div>
          <div className="list-meta"><label className="field"><span>Role</span><select aria-label={`${member.name} role`} disabled={!editable || pending} onChange={(event) => {
            if (!member.id) return;
            const nextRole = event.target.value as BusinessAssignableRole;
            const previousRole = selectedRole;
            setMemberRoles((current) => ({ ...current, [member.id as string]: nextRole }));
            perform(
              () => updateBusinessMemberRole(account.id, member.id as string, nextRole),
              `${member.name}'s role was updated.`,
              "member",
              undefined,
              () => setMemberRoles((current) => ({ ...current, [member.id as string]: previousRole })),
            );
          }} value={selectedRole}>
            <option disabled value="owner">Owner</option>
            <option disabled={!canAssignAdmin} value="admin">Administrator</option>
            <option value="requester">Requester</option>
            <option value="viewer">Viewer</option>
          </select></label>{editable && <button aria-label={`Remove ${member.name}`} className="claim-button" disabled={pending} onClick={() => {
            if (!member.id || !window.confirm(`Remove ${member.name} from this business account?`)) return;
            perform(() => removeBusinessMember(account.id, member.id as string), "The team member was removed.", "member");
          }} type="button"><IconTrash size={15} /></button>}</div>
          <span />
        </article>;
      })}</div>
      {account.canManage && <form className="settings-form" onSubmit={submitMember}>
        <div className="profile-address-label"><IconPlus size={17} /><div><strong>Add an existing customer</strong><span>Access begins immediately after the roster entry is created.</span></div></div>
        <div className="field-row">
          <label className="field"><span>Customer account email</span><input autoComplete="email" maxLength={254} onChange={(event) => setMemberEmail(event.target.value)} placeholder="teammate@example.com" required type="email" value={memberEmail} /></label>
          <label className="field"><span>Role</span><select onChange={(event) => setMemberRole(event.target.value as BusinessAssignableRole)} value={memberRole}>{canAssignAdmin && <option value="admin">Administrator</option>}<option value="requester">Requester</option><option value="viewer">Viewer</option></select></label>
        </div>
        {notice?.scope === "member" && <NoticeMessage notice={notice} />}
        <button className="button" disabled={pending} type="submit">{pending ? "Adding…" : "Add to roster"}{!pending && <IconPlus size={18} />}</button>
      </form>}
    </section>

    <div className="empty-prompt"><span><IconInfoCircle size={30} /></span><div><h3>Email invitations are not available yet</h3><p>The current data model stores active roster memberships only. Ask a teammate to create a customer account first, then add their exact account email above.</p></div></div>
  </>;
}

function NoticeMessage({ notice }: { notice: Exclude<Notice, null> }) {
  return <p className={notice.kind === "success" ? "form-success" : "form-error"} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>;
}

function roleLabel(role: BusinessMemberRole) {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Administrator";
  if (role === "requester") return "Requester";
  return "Viewer";
}

function formatAddress(location: BusinessLocationView) {
  return [location.addressLine1, location.addressLine2, `${location.city}, ${location.state} ${location.zip}`].filter(Boolean).join(" · ");
}
