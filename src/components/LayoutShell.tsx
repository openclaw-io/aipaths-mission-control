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
      <main className="ml-64 flex-1 p-8">
        <div className="fixed right-8 top-8 z-30">
          <GatewayStatus />
        </div>
        {children}
      </main>
    </div>
  );
}
