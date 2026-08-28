import Link from "next/link";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="Send a Scout home">
      <img className="brand-mark" src="/logo-mark.svg" alt="" />
      <span className="brand-name"><span>Send a</span> Scout</span>
    </Link>
  );
}
