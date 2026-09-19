import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  metadataBase: new URL("https://sendascout.com"),
  title: "Send a Scout | Need eyes somewhere?",
  description:
    "Get current photos, video, and answers from a real person on location. Property, vehicle, purchase, and project checks with a PDF report.",
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "Send a Scout | Need eyes somewhere?",
    description: "Need eyes somewhere? Get current photos, video, and answers without making the trip.",
    url: "https://sendascout.com",
    siteName: "Send a Scout",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={manrope.variable}>
        <ClerkProvider
          appearance={{
            variables: {
              colorPrimary: "#ff5a3c",
              colorForeground: "#082b45",
              colorBackground: "#fffdf8",
              borderRadius: "0.8rem",
              fontFamily: "var(--font-manrope), Arial, sans-serif",
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
