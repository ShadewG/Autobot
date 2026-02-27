"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { ExternalLink, Loader2, Monitor, ChevronLeft, ChevronRight, ImageOff, History } from "lucide-react";
import { fetcher } from "@/lib/api";
import type { PortalScreenshotsResponse, PortalScreenshot } from "@/lib/api";

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
  isLive?: boolean;
}

export function PortalLiveView({ caseId, initialScreenshotUrl, portalTaskUrl, isLive = true }: PortalLiveViewProps) {
  const [stopped, setStopped] = useState(!isLive);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const filmstripRef = useRef<HTMLDivElement>(null);

  // Live polling for current screenshot (only in live mode)
  const { data } = useSWR<PortalScreenshotResponse>(
    isLive && !stopped ? `/requests/${caseId}/portal-screenshot` : null,
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

  // Screenshot history from activity_log
  const { data: historyData } = useSWR<PortalScreenshotsResponse>(
    `/requests/${caseId}/portal-screenshots`,
    fetcher,
    {
      refreshInterval: isLive && !stopped ? 10000 : 0,
      revalidateOnFocus: false,
    }
  );

  const screenshots = historyData?.screenshots || [];
  const screenshotUrl = data?.screenshot_url || initialScreenshotUrl || null;
  const taskUrl = data?.portal_task_url || portalTaskUrl || null;
  // Keep hook order stable across renders (don't declare hooks after early returns)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // In history mode, hide entirely if there are no screenshots (data loaded and empty)
  if (!isLive && historyData && screenshots.length === 0) {
    return null;
  }

  // Current display: in live mode show latest from live poll, in history mode show last from history
  const mainImageUrl = isLive
    ? screenshotUrl
    : (screenshots.length > 0 ? screenshots[screenshots.length - 1].url : null);

  // Selected image for main view (click thumbnail to select)
  const displayUrl = selectedIndex !== null && screenshots[selectedIndex]
    ? screenshots[selectedIndex].url
    : mainImageUrl;

  // Auto-scroll filmstrip to end when new screenshots arrive in live mode
  useEffect(() => {
    if (isLive && !stopped && filmstripRef.current) {
      filmstripRef.current.scrollLeft = filmstripRef.current.scrollWidth;
    }
  }, [screenshots.length, isLive, stopped]);

  const handleImageError = useCallback((url: string) => {
    setFailedUrls(prev => new Set(prev).add(url));
  }, []);

  const openLightbox = (index: number) => setLightboxIndex(index);
  const closeLightbox = () => setLightboxIndex(null);

  const navLightbox = (dir: -1 | 1) => {
    if (lightboxIndex === null || screenshots.length === 0) return;
    const next = lightboxIndex + dir;
    if (next >= 0 && next < screenshots.length) {
      setLightboxIndex(next);
    }
  };

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") navLightbox(-1);
      if (e.key === "ArrowRight") navLightbox(1);
      if (e.key === "Escape") closeLightbox();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const showFilmstrip = screenshots.length > 1;

  return (
    <>
      <Card className="border-blue-700/50 bg-blue-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {isLive ? (
              <Monitor className="h-4 w-4 text-blue-400" />
            ) : (
              <History className="h-4 w-4 text-muted-foreground" />
            )}
            Portal {isLive ? "Submission" : "Screenshots"}
            {isLive && !stopped && (
              <span className="relative flex h-2.5 w-2.5 ml-1">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
              </span>
            )}
            {isLive && !stopped && (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400 ml-0.5">
                Live
              </span>
            )}
            {screenshots.length > 0 && (
              <span className="text-[10px] text-muted-foreground ml-auto">
                {screenshots.length} screenshot{screenshots.length !== 1 ? "s" : ""}
              </span>
            )}
            {taskUrl && (
              <a
                href={taskUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${screenshots.length > 0 ? "" : "ml-auto "}text-[10px] text-blue-400 hover:underline flex items-center gap-1`}
              >
                <ExternalLink className="h-3 w-3" /> Skyvern
              </a>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Main image */}
          {displayUrl && !failedUrls.has(displayUrl) ? (
            <div
              className="relative rounded-md overflow-hidden border border-border/50 cursor-pointer"
              onClick={() => {
                const idx = selectedIndex ?? (screenshots.length > 0 ? screenshots.length - 1 : -1);
                if (idx >= 0) openLightbox(idx);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displayUrl}
                alt="Portal browser screenshot"
                className="w-full h-auto rounded-md"
                onError={() => handleImageError(displayUrl)}
              />
              {isLive && !stopped && (
                <div className="absolute top-2 right-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  Updating...
                </div>
              )}
            </div>
          ) : displayUrl && failedUrls.has(displayUrl) ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2 border border-border/50 rounded-md">
              <ImageOff className="h-5 w-5" />
              <span className="text-xs">Screenshot expired</span>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              {isLive ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                  <span className="text-xs">Waiting for first screenshot...</span>
                </>
              ) : (
                <>
                  <ImageOff className="h-5 w-5" />
                  <span className="text-xs">No screenshots available</span>
                </>
              )}
            </div>
          )}

          {/* Filmstrip thumbnails */}
          {showFilmstrip && (
            <div ref={filmstripRef} className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
              {screenshots.map((ss, i) => (
                <button
                  key={ss.id}
                  className={`flex-shrink-0 rounded border overflow-hidden transition-all ${
                    (selectedIndex ?? screenshots.length - 1) === i
                      ? "border-blue-500 ring-1 ring-blue-500/50"
                      : "border-border/50 hover:border-blue-400/50"
                  }`}
                  onClick={() => setSelectedIndex(i)}
                  title={`Screenshot #${ss.sequence_index + 1}`}
                >
                  {failedUrls.has(ss.url) ? (
                    <div className="w-16 h-10 flex items-center justify-center bg-muted">
                      <ImageOff className="h-3 w-3 text-muted-foreground" />
                    </div>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={ss.url}
                      alt={`Screenshot #${ss.sequence_index + 1}`}
                      className="w-16 h-10 object-cover"
                      onError={() => handleImageError(ss.url)}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lightbox dialog */}
      <Dialog open={lightboxIndex !== null} onOpenChange={(open) => { if (!open) closeLightbox(); }}>
        <DialogContent className="max-w-4xl w-full p-0 bg-black/95 border-none">
          {lightboxIndex !== null && screenshots[lightboxIndex] && (
            <div className="relative">
              {/* Navigation buttons */}
              {lightboxIndex > 0 && (
                <button
                  className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                  onClick={() => navLightbox(-1)}
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
              {lightboxIndex < screenshots.length - 1 && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                  onClick={() => navLightbox(1)}
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              )}

              {/* Image */}
              {failedUrls.has(screenshots[lightboxIndex].url) ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
                  <ImageOff className="h-8 w-8" />
                  <span className="text-sm">Screenshot expired</span>
                </div>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={screenshots[lightboxIndex].url}
                  alt={`Screenshot #${screenshots[lightboxIndex].sequence_index + 1}`}
                  className="w-full h-auto"
                  onError={() => handleImageError(screenshots[lightboxIndex].url)}
                />
              )}

              {/* Counter */}
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-white">
                {lightboxIndex + 1} / {screenshots.length}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
