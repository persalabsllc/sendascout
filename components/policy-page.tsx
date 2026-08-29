import Link from "next/link";
import { Brand } from "@/components/brand";

export function PolicyPage({ eyebrow, title, intro, version, children }: { eyebrow: string; title: string; intro: string; version: string; children: React.ReactNode }) {
  return <main className="legal-page"><header className="legal-header"><Link href="/"><Brand /></Link><nav><Link href="/policies">Marketplace policies</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></nav></header><article className="legal-card"><span className="kicker">{eyebrow}</span><h1>{title}</h1><p className="legal-intro">{intro}</p><p className="legal-date">Effective August 29, 2026 · Version {version}</p>{children}</article></main>;
}
