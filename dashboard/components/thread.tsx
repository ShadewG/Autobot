"use client";

import { memo, useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ThreadMessage } from "@/lib/types";
import { formatDateTime, cn } from "@/lib/utils";
import { Mail, Globe, Phone, Truck, FileText, FileCode } from "lucide-react";

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
    <div className="w-full">
      {/* Header - always full width */}
      <div className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground mb-1",
        isOutbound ? "justify-end" : "justify-start"
      )}>
        {channelIcons[message.channel]}
        <span>{isOutbound ? "To:" : "From:"}</span>
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

      {/* Message bubble - full width, colored border to indicate direction */}
      <div
        className={cn(
          "rounded-lg p-3 w-full border-l-4",
          isOutbound
            ? "bg-primary/5 border-l-primary"
            : "bg-muted border-l-amber-500"
        )}
      >
        <p className="text-xs font-semibold mb-1.5">{message.subject}</p>
        <p className="text-sm whitespace-pre-wrap break-words">{displayBody}</p>
      </div>

      {/* Attachments */}
      {message.attachments.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {message.attachments.map((att, i) => (
            <Badge key={i} variant="outline" className="text-xs">
              {att.filename}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
});

interface ThreadProps {
  messages: ThreadMessage[];
}

const STORAGE_KEY = 'email-view-mode';

export function Thread({ messages }: ThreadProps) {
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

  return (
    <div className="space-y-2">
      {/* Toggle buttons - only show if any message has raw content */}
      {hasAnyRawContent && (
        <div className="flex items-center gap-1 justify-end">
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
      <ScrollArea className="h-[400px] w-full">
        <div className="space-y-4 pr-2 w-full">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} showRaw={showRaw} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
