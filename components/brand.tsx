import Link from "next/link";
import Image from "next/image";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link className="brand" href={href} aria-label="Send a Scout home">
      <Image className="brand-mark" src="/logo-mark.svg" alt="" width={43} height={43} priority />
      <span className="brand-name"><span>Send a</span> Scout</span>
    </Link>
  );
}
