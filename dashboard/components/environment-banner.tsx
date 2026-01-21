"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { AlertTriangle, Shield, Zap, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

interface EnvironmentStatus {
  success: boolean;
  shadow_mode: boolean;
  execution_mode: "DRY" | "LIVE";
  is_shadow: boolean;
  description: string;
}

export function EnvironmentBanner() {
  const { data, error } = useSWR<EnvironmentStatus>(
    "/shadow/status",
    fetcher,
    { refreshInterval: 60000 } // Refresh every minute
  );

  if (error || !data) {
    return null;
  }

  const isLive = data.execution_mode === "LIVE";
  const isShadow = data.is_shadow;

  // Don't show banner in normal DRY mode (development default)
  // Only show when LIVE or when shadow mode is explicitly enabled
  if (!isLive && !isShadow) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed top-0 left-0 right-0 z-50 px-4 py-1.5 text-center text-sm font-medium flex items-center justify-center gap-4",
        isLive
          ? "bg-red-600 text-white"
          : isShadow
          ? "bg-amber-500 text-black"
          : "bg-blue-600 text-white"
      )}
    >
      {/* Execution Mode */}
      <div className="flex items-center gap-1.5">
        {isLive ? (
          <Zap className="h-4 w-4" />
        ) : (
          <FlaskConical className="h-4 w-4" />
        )}
        <span className="font-bold">
          EXECUTION_MODE={data.execution_mode}
        </span>
      </div>

      <span className="opacity-50">|</span>

      {/* Shadow Mode */}
      <div className="flex items-center gap-1.5">
        {isShadow ? (
          <Shield className="h-4 w-4" />
        ) : (
          <AlertTriangle className="h-4 w-4" />
        )}
        <span className="font-bold">
          SHADOW_MODE={data.shadow_mode ? "true" : "false"}
        </span>
      </div>

      {/* Warning for LIVE mode */}
      {isLive && !isShadow && (
        <>
          <span className="opacity-50">|</span>
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" />
            LIVE EXECUTION - Actions will be sent!
          </span>
        </>
      )}
    </div>
  );
}
