"use client";

import { useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExternalLink, Loader2, Monitor } from "lucide-react";
import { fetcher } from "@/lib/api";

interface PortalScreenshotResponse {
  success: boolean;
  screenshot_url: string | null;
  status: string | null;
  portal_task_url: string | null;
  updated_at: string | null;
}

const TERMINAL_STATUSES = [
  "completed", "succeeded", "success", "failed", "terminated", "error",
  "cancelled", "timed_out",
];

function isTerminalStatus(status: string | null): boolean {
  if (!status) return false;
  return TERMINAL_STATUSES.includes(status.toLowerCase());
}

interface PortalLiveViewProps {
  caseId: string;
  initialScreenshotUrl?: string | null;
  portalTaskUrl?: string | null;
}

export function PortalLiveView({ caseId, initialScreenshotUrl, portalTaskUrl }: PortalLiveViewProps) {
  const [stopped, setStopped] = useState(false);

  const { data } = useSWR<PortalScreenshotResponse>(
    !stopped ? `/requests/${caseId}/portal-screenshot` : null,
    fetcher,
    {
      refreshInterval: 5000,
      onSuccess: (resp) => {
        if (isTerminalStatus(resp.status)) {
          setStopped(true);
        }
      },
    }
  );

  const screenshotUrl = data?.screenshot_url || initialScreenshotUrl || null;
  const taskUrl = data?.portal_task_url || portalTaskUrl || null;

  return (
    <Card className="border-blue-700/50 bg-blue-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Monitor className="h-4 w-4 text-blue-400" />
          Portal Submission
          {!stopped && (
            <span className="relative flex h-2.5 w-2.5 ml-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
            </span>
          )}
          {!stopped && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400 ml-0.5">
              Live
            </span>
          )}
          {taskUrl && (
            <a
              href={taskUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[10px] text-blue-400 hover:underline flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" /> Skyvern
            </a>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {screenshotUrl ? (
          <div className="relative rounded-md overflow-hidden border border-border/50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={screenshotUrl}
              alt="Portal browser screenshot"
              className="w-full h-auto rounded-md"
            />
            {!stopped && (
              <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Updating...
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
            <span className="text-xs">Waiting for first screenshot...</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
