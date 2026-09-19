import { SeeLanding } from "@/components/see-site";
import { getSeeTemplate } from "@/lib/see-it";
const template = getSeeTemplate("custom")!;
export const metadata = { title: `${template.name} | Send a Scout`, description: `${template.description} Photos, video, and an organized PDF report. From $${template.priceCents / 100}.`, alternates: { canonical: "/custom" } };
export default function Page() { return <SeeLanding template={template} />; }
