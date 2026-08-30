"use client";

import { archiveMissionTemplate } from "@/app/actions/customer-features";

export function ArchiveTemplateForm({ templateId }: { templateId: string }) {
  return <form
    action={archiveMissionTemplate}
    onSubmit={(event) => {
      if (!window.confirm("Archive this template? Any recurring schedule using it will also end.")) event.preventDefault();
    }}
  >
    <input type="hidden" name="templateId" value={templateId} />
    <button type="submit">Archive</button>
  </form>;
}
