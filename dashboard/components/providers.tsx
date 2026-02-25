"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SWRConfig } from "swr";
import { UserFilterProvider } from "./user-filter";

/**
 * Global SWR fetcher with consistent error handling.
 * - Throws on non-2xx responses
 * - Includes credentials for cookie-based auth
 * - Logs errors with response body snippet for debugging
 */
const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
};

interface ProvidersProps {
  children: React.ReactNode;
}

/**
 * Client-side providers wrapper.
 * Keeps app/layout.tsx as a server component.
 */
export function Providers({ children }: ProvidersProps) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        dedupingInterval: 5000,
        onError: (err, key) => {
          console.error("SWR error:", key, err);
        },
      }}
    >
      <UserFilterProvider>
        <TooltipProvider delayDuration={300}>
          {children}
        </TooltipProvider>
      </UserFilterProvider>
    </SWRConfig>
  );
}
