"use client";

import { memo, useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ThreadMessage } from "@/lib/types";
import { formatDateTime, cn } from "@/lib/utils";
import { Mail, Globe, Phone, Truck, FileText, FileCode, Loader2, Paperclip, Download, ExternalLink } from "lucide-react";

const channelIcons: Record<string, React.ReactNode> = {
  EMAIL: <Mail className="h-3 w-3" />,
  PORTAL: <Globe className="h-3 w-3" />,
  CALL: <Phone className="h-3 w-3" />,
  MAIL: <Truck className="h-3 w-3" />,
};

interface MessageBubbleProps {
  message: ThreadMessage;
  showRaw: boolean;
}

const MessageBubble = memo(function MessageBubble({ message, showRaw }: MessageBubbleProps) {
  const isOutbound = message.direction === "OUTBOUND";

  // Determine which body content to show
  const displayBody = showRaw && message.raw_body ? message.raw_body : message.body;
  const hasRawVersion = message.raw_body && message.raw_body !== message.body;

  return (
    <div className="w-full overflow-hidden">
      {/* Header - always full width */}
      <div className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground mb-1",
        isOutbound ? "justify-end" : "justify-start"
      )}>
        {channelIcons[message.channel]}
        <span className="shrink-0">{isOutbound ? "To:" : "From:"}</span>
        <span className="font-medium truncate max-w-[200px]">
          {isOutbound ? (message.to_email || "Unknown") : (message.from_email || "records@agency.gov")}
        </span>
        <span>•</span>
        <span className="whitespace-nowrap">{formatDateTime(message.sent_at)}</span>
        {hasRawVersion && (
          <Badge variant="outline" className="text-[10px] ml-1">
            {showRaw ? "raw" : "clean"}
          </Badge>
        )}
      </div>

      {/* Classification, sentiment, and AI summary for inbound messages */}
      {!isOutbound && (message.classification || message.sentiment || message.summary) && (
        <div className="mt-0.5 mb-0.5 space-y-1">
          <div className="flex items-center gap-1">
            {message.classification && (
              <Badge variant="outline" className="text-[10px]">
                {message.classification}
              </Badge>
            )}
            {message.sentiment && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  message.sentiment.toUpperCase() === 'POSITIVE' && "text-green-400",
                  message.sentiment.toUpperCase() === 'NEGATIVE' && "text-red-400",
                  message.sentiment.toUpperCase() === 'HOSTILE' && "text-red-300 bg-red-500/10"
                )}
              >
                {message.sentiment}
              </Badge>
            )}
          </div>
          {message.summary && (
            <p className="text-[11px] text-muted-foreground italic pl-1 border-l-2 border-muted">
              {message.summary}
            </p>
          )}
        </div>
      )}

      {/* Message bubble - full width, colored border to indicate direction */}
      <div
        className={cn(
          "p-3 w-full border-l-4 overflow-hidden",
          isOutbound
            ? "bg-primary/5 border-l-primary"
            : "bg-muted border-l-amber-500"
        )}
      >
        <p className="text-xs font-semibold mb-1.5">{message.subject}</p>
        <p className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{displayBody}</p>
      </div>

      {/* Sending indicator for optimistic messages */}
      {(message as any)._sending && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1 animate-pulse">
          <Loader2 className="h-3 w-3 animate-spin" />
          Sending...
        </div>
      )}

      {/* Attachments */}
      {message.attachments.length > 0 && (
        <div className="mt-2 space-y-1">
          {message.attachments.map((att, i) => {
            const isPdf = att.content_type === "application/pdf" || att.filename?.toLowerCase().endsWith(".pdf");
            const downloadUrl = `/api/monitor/attachments/${att.id}/download`;
            const sizeLabel = att.size_bytes
              ? att.size_bytes > 1024 * 1024
                ? `${(att.size_bytes / (1024 * 1024)).toFixed(1)} MB`
                : `${Math.round(att.size_bytes / 1024)} KB`
              : null;

            return (
              <div key={i} className="flex items-center gap-2 rounded border border-border/60 bg-muted/30 px-2.5 py-1.5">
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium truncate flex-1 min-w-0">{att.filename}</span>
                {sizeLabel && <span className="text-[10px] text-muted-foreground shrink-0">{sizeLabel}</span>}
                {isPdf && (
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
                  >
                    <ExternalLink className="h-3 w-3" /> View
                  </a>
                )}
                <a
                  href={downloadUrl}
                  download={att.filename}
                  className="text-[10px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
                >
                  <Download className="h-3 w-3" /> Download
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

interface ThreadProps {
  messages: ThreadMessage[];
  maxHeight?: string;
}

const STORAGE_KEY = 'email-view-mode';

export function Thread({ messages, maxHeight }: ThreadProps) {
  const [showRaw, setShowRaw] = useState(false);

  // Load preference from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'raw') {
      setShowRaw(true);
    }
  }, []);

  // Save preference to localStorage when changed
  const handleToggle = (raw: boolean) => {
    setShowRaw(raw);
    localStorage.setItem(STORAGE_KEY, raw ? 'raw' : 'clean');
  };

  // Check if any messages have raw versions
  const hasAnyRawContent = messages.some(
    (m) => m.raw_body && m.raw_body !== m.body
  );

  if (messages.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No messages yet
      </div>
    );
  }

  const isFullHeight = maxHeight === "h-full";

  return (
    <div className={cn(isFullHeight ? "flex flex-col h-full" : "space-y-2")}>
      {/* Toggle buttons - only show if any message has raw content */}
      {hasAnyRawContent && (
        <div className={cn("flex items-center gap-1 justify-end", isFullHeight && "shrink-0 px-2 pt-1")}>
          <Button
            size="sm"
            variant={showRaw ? "ghost" : "secondary"}
            onClick={() => handleToggle(false)}
            className="h-6 text-xs px-2"
          >
            <FileText className="h-3 w-3 mr-1" />
            Clean
          </Button>
          <Button
            size="sm"
            variant={showRaw ? "secondary" : "ghost"}
            onClick={() => handleToggle(true)}
            className="h-6 text-xs px-2"
          >
            <FileCode className="h-3 w-3 mr-1" />
            Raw
          </Button>
        </div>
      )}
      <ScrollArea className={cn(isFullHeight ? "flex-1 min-h-0" : (maxHeight || "h-[400px]"), "w-full")}>
        <div className="space-y-4 pr-2 w-full">
          {[...messages].reverse().map((message) => (
            <MessageBubble key={message.id} message={message} showRaw={showRaw} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
