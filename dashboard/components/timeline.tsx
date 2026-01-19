"use client";

import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TimelineEvent, EventType } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import {
  FileText,
  Send,
  Inbox,
  DollarSign,
  XCircle,
  Clock,
  Globe,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

const eventIcons: Record<EventType, React.ReactNode> = {
  CREATED: <FileText className="h-4 w-4" />,
  SENT: <Send className="h-4 w-4" />,
  RECEIVED: <Inbox className="h-4 w-4" />,
  FEE_QUOTE: <DollarSign className="h-4 w-4" />,
  DENIAL: <XCircle className="h-4 w-4" />,
  FOLLOW_UP: <Clock className="h-4 w-4" />,
  PORTAL_TASK: <Globe className="h-4 w-4" />,
};

const eventColors: Record<EventType, string> = {
  CREATED: "bg-blue-100 text-blue-800",
  SENT: "bg-green-100 text-green-800",
  RECEIVED: "bg-purple-100 text-purple-800",
  FEE_QUOTE: "bg-yellow-100 text-yellow-800",
  DENIAL: "bg-red-100 text-red-800",
  FOLLOW_UP: "bg-orange-100 text-orange-800",
  PORTAL_TASK: "bg-cyan-100 text-cyan-800",
};

interface TimelineEventItemProps {
  event: TimelineEvent;
}

function TimelineEventItem({ event }: TimelineEventItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex gap-3 pb-4">
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          eventColors[event.type] || "bg-gray-100 text-gray-800"
        }`}
      >
        {eventIcons[event.type] || <FileText className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{event.summary}</span>
          {event.ai_audit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(event.timestamp)}
        </p>
        {expanded && event.ai_audit && (
          <Card className="mt-2">
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-xs">AI Analysis</CardTitle>
            </CardHeader>
            <CardContent className="py-2 px-3">
              <ul className="text-xs space-y-1">
                {event.ai_audit.summary.map((point, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              {event.ai_audit.confidence !== undefined && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Confidence:
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {Math.round(event.ai_audit.confidence * 100)}%
                  </Badge>
                </div>
              )}
              {event.ai_audit.risk_flags && event.ai_audit.risk_flags.length > 0 && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Flags:</span>
                  {event.ai_audit.risk_flags.map((flag, i) => (
                    <Badge key={i} variant="destructive" className="text-xs">
                      {flag}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

interface TimelineProps {
  events: TimelineEvent[];
}

export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No timeline events yet
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="pr-4">
        {events.map((event) => (
          <TimelineEventItem key={event.id} event={event} />
        ))}
      </div>
    </ScrollArea>
  );
}
