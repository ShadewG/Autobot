"use client";

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

function MessageBubble({ message }: MessageBubbleProps) {
  const isOutbound = message.direction === "OUTBOUND";

  return (
    <div
      className={cn(
        "flex flex-col gap-1 max-w-[85%]",
        isOutbound ? "ml-auto items-end" : "mr-auto items-start"
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {channelIcons[message.channel]}
        <span>{isOutbound ? "To:" : "From:"}</span>
        <span className="font-medium">
          {isOutbound ? message.to_email : message.from_email}
        </span>
        <span>•</span>
        <span>{formatDateTime(message.sent_at)}</span>
      </div>
      <div
        className={cn(
          "rounded-lg p-3",
          isOutbound
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        )}
      >
        <p className="text-xs font-medium mb-1">{message.subject}</p>
        <p className="text-sm whitespace-pre-wrap">{message.body}</p>
      </div>
      {message.attachments.length > 0 && (
        <div className="flex items-center gap-1">
          {message.attachments.map((att, i) => (
            <Badge key={i} variant="outline" className="text-xs">
              {att.filename}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

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
    <ScrollArea className="h-[calc(100vh-400px)]">
      <div className="space-y-4 pr-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </ScrollArea>
  );
}
