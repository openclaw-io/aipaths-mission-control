import type { Metadata } from "next";
import "./globals.css";
import { LayoutShell } from "@/components/LayoutShell";
import { isLocalAuthDisabled } from "@/lib/auth/local";

export const metadata: Metadata = {
  title: "AIPaths Mission Control",
  description: "Dashboard for managing AI agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const authEnabled = !isLocalAuthDisabled();

  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full bg-[#0a0a0f] text-gray-200">
        <LayoutShell authEnabled={authEnabled}>{children}</LayoutShell>
      </body>
    </html>
  );
}
