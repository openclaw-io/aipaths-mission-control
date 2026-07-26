"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import GatewayStatus from "./GatewayStatus";
import ExecutionWindowTopbar from "./ExecutionWindowTopbar";

export function LayoutShell({
  children,
  authEnabled,
}: {
  children: React.ReactNode;
  authEnabled: boolean;
}) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Sidebar authEnabled={authEnabled} />
      <main className="ml-64 flex min-h-screen w-[calc(100%-16rem)] min-w-0 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-3 px-8 py-3">
          <ExecutionWindowTopbar />
          <GatewayStatus />
        </div>
        <div className="min-w-0 flex-1 px-8 pb-8">
          {children}
        </div>
      </main>
    </div>
  );
}
