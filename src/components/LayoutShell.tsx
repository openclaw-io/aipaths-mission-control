"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import GatewayStatus from "./GatewayStatus";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-64 flex-1">
        {/* Top bar */}
        <div className="flex items-center justify-end px-8 py-4">
          <GatewayStatus />
        </div>
        <div className="px-8 pb-8">{children}</div>
      </main>
    </div>
  );
}
