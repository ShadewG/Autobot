"use client";

import { memo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { ThreadMessage } from "@/lib/types";
import { formatDateTime, cn } from "@/lib/utils";
import { Mail, Globe, Phone, Truck } from "lucide-react";

const channelIcons: Record<string, React.ReactNode> = {
  EMAIL: <Mail className="h-3 w-3" />,
  PORTAL: <Globe className="h-3 w-3" />,
  CALL: <Phone className="h-3 w-3" />,
  MAIL: <Truck className="h-3 w-3" />,
};

interface MessageBubbleProps {
  message: ThreadMessage;
}

const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  const isOutbound = message.direction === "OUTBOUND";

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
          {isOutbound ? message.to_email : message.from_email}
        </span>
        <span>•</span>
        <span className="whitespace-nowrap">{formatDateTime(message.sent_at)}</span>
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
        <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
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

export function Thread({ messages }: ThreadProps) {
  if (messages.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No messages yet
      </div>
    );
  }

  return (
    <ScrollArea className="h-[400px] w-full">
      <div className="space-y-4 pr-2 w-full">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </ScrollArea>
  );
}
