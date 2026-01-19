"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TimelineEvent } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { Bot, Brain, AlertTriangle } from "lucide-react";

interface AgentLogProps {
  events: TimelineEvent[];
}

export function AgentLog({ events }: AgentLogProps) {
  const auditEvents = events.filter((e) => e.ai_audit);

  if (auditEvents.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Bot className="h-12 w-12 mx-auto mb-2 opacity-50" />
        <p>No agent decisions recorded yet</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="space-y-4 pr-4">
        {auditEvents.map((event) => (
          <Card key={event.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Brain className="h-4 w-4 text-purple-500" />
                  {event.type}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(event.timestamp)}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium">{event.summary}</p>

              {event.ai_audit && (
                <div className="bg-muted rounded-md p-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    AI Analysis
                  </p>
                  <ul className="text-sm space-y-1">
                    {event.ai_audit.summary.map((point, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-muted-foreground mt-1">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="flex items-center gap-2 pt-2 border-t mt-2">
                    {event.ai_audit.confidence !== undefined && (
                      <Badge variant="outline" className="text-xs">
                        {Math.round(event.ai_audit.confidence * 100)}% confidence
                      </Badge>
                    )}
                    {event.ai_audit.policy_rule && (
                      <Badge variant="secondary" className="text-xs">
                        {event.ai_audit.policy_rule}
                      </Badge>
                    )}
                  </div>

                  {event.ai_audit.risk_flags &&
                    event.ai_audit.risk_flags.length > 0 && (
                      <div className="flex items-center gap-2 pt-2">
                        <AlertTriangle className="h-3 w-3 text-yellow-500" />
                        {event.ai_audit.risk_flags.map((flag, i) => (
                          <Badge key={i} variant="destructive" className="text-xs">
                            {flag}
                          </Badge>
                        ))}
                      </div>
                    )}

                  {event.ai_audit.citations &&
                    event.ai_audit.citations.length > 0 && (
                      <div className="text-xs text-muted-foreground pt-2 border-t mt-2">
                        <span className="font-medium">Citations:</span>
                        <ul className="mt-1 space-y-1">
                          {event.ai_audit.citations.map((citation, i) => (
                            <li key={i}>
                              {citation.url ? (
                                <a
                                  href={citation.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-primary hover:underline"
                                >
                                  {citation.label}
                                </a>
                              ) : (
                                citation.label
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                </div>
              )}

              {event.raw_content && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    View raw content
                  </summary>
                  <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-40">
                    {event.raw_content}
                  </pre>
                </details>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
