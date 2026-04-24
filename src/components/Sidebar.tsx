"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const NAV_ITEMS = [
  { href: "/", label: "Overview", emoji: "📊" },
  { href: "/office", label: "Office", emoji: "🏢" },
  { href: "/agents", label: "Agents", emoji: "🤖" },
  { href: "/tasks", label: "Tasks", emoji: "📋" },
  { href: "/projects", label: "Projects", emoji: "📐" },
  { href: "/blogs", label: "Blogs", emoji: "✍️" },
  { href: "/intel", label: "Intel Inbox", emoji: "🧠" },
  { href: "/execution-window", label: "Execution Window", emoji: "🕒" },
  { href: "/costs", label: "Costs", emoji: "💰" },
  { href: "/crons", label: "Crons", emoji: "🕐" },
  { href: "/memory", label: "Memory", emoji: "🧠" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUserEmail(user?.email ?? null);
    });
  }, [supabase.auth]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="fixed left-0 top-0 flex h-screen w-64 flex-col border-r border-white/10 bg-[#111118]">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-5">
        <h1 className="text-lg font-bold text-white">🛰️ Mission Control</h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV_ITEMS.map(({ href, label, emoji }) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                isActive
                  ? "bg-blue-500/15 text-blue-400"
                  : "text-gray-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span>{emoji}</span>
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer — User + Sign Out */}
      <div className="border-t border-white/10 px-4 py-4">
        {userEmail && (
          <p className="mb-2 truncate text-xs text-gray-500">{userEmail}</p>
        )}
        <button
          onClick={handleSignOut}
          className="w-full rounded-lg px-3 py-2 text-sm text-gray-400 transition hover:bg-white/5 hover:text-white"
        >
          Sign Out
        </button>
      </div>
    </aside>
  );
}
