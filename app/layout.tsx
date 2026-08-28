import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  metadataBase: new URL("https://sendascout.com"),
  title: "Send a Scout | Your trusted local presence, on demand",
  description:
    "Send a trusted local Scout to check it, move it, meet it, or wait for it—when you can't be there yourself.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Send a Scout | Your trusted local presence, on demand",
    description: "Need someone there? Send a vetted local Scout.",
    url: "https://sendascout.com",
    siteName: "Send a Scout",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={manrope.variable}>{children}</body>
    </html>
  );
}
