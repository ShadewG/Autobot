"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { SWRConfig } from "swr";

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
        revalidateOnFocus: false,
        dedupingInterval: 5000,
      }}
    >
      <TooltipProvider delayDuration={300}>
        {children}
      </TooltipProvider>
    </SWRConfig>
  );
}
