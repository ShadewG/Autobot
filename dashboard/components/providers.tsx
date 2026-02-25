"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SWRConfig } from "swr";
import { AuthProvider } from "./auth-provider";
import { UserFilterProvider } from "./user-filter";

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
      <AuthProvider>
        <UserFilterProvider>
          <TooltipProvider delayDuration={300}>
            {children}
          </TooltipProvider>
        </UserFilterProvider>
      </AuthProvider>
    </SWRConfig>
  );
}
