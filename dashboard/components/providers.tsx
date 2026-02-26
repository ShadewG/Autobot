"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SWRConfig } from "swr";
import { Toaster } from "sonner";
import { AuthProvider } from "./auth-provider";
import { UserFilterProvider } from "./user-filter";
import { useEventStream } from "@/lib/use-events";

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
};

function EventStreamSubscriber({ children }: { children: React.ReactNode }) {
  useEventStream();
  return <>{children}</>;
}

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
            <EventStreamSubscriber>
              {children}
            </EventStreamSubscriber>
            <Toaster
              theme="dark"
              position="bottom-right"
              toastOptions={{
                style: { background: "#18181b", border: "1px solid #27272a", color: "#fafafa", fontSize: "12px" },
              }}
            />
          </TooltipProvider>
        </UserFilterProvider>
      </AuthProvider>
    </SWRConfig>
  );
}
