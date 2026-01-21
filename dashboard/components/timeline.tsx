"use client";

import { useState, useMemo, memo, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TimelineEvent, EventType } from "@/lib/types";
import { formatDateTime, cn } from "@/lib/utils";
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
  MessageSquare,
  Activity,
  Search,
  Bot,
  AlertTriangle,
  Filter,
  Layers,
  CheckCircle,
  Play,
  Pause,
  RotateCcw,
  Mail,
  UserCheck,
  Shield,
  Zap,
} from "lucide-react";

const eventIcons: Record<string, React.ReactNode> = {
  // Case lifecycle
  CREATED: <FileText className="h-4 w-4" />,
  SENT: <Send className="h-4 w-4" />,
  RECEIVED: <Inbox className="h-4 w-4" />,
  EMAIL_SENT: <Mail className="h-4 w-4" />,
  EMAIL_RECEIVED: <Inbox className="h-4 w-4" />,

  // Fee/Cost events
  FEE_QUOTE: <DollarSign className="h-4 w-4" />,
  FEE_ACCEPTED: <CheckCircle className="h-4 w-4" />,
  FEE_NEGOTIATED: <DollarSign className="h-4 w-4" />,

  // Response classifications
  DENIAL: <XCircle className="h-4 w-4" />,
  PARTIAL_DENIAL: <AlertTriangle className="h-4 w-4" />,
  RECORDS_PROVIDED: <CheckCircle className="h-4 w-4" />,

  // Follow-ups
  FOLLOW_UP: <Clock className="h-4 w-4" />,
  FOLLOWUP_SCHEDULED: <Clock className="h-4 w-4" />,
  FOLLOWUP_TRIGGERED: <RotateCcw className="h-4 w-4" />,

  // Portal tasks
  PORTAL_TASK: <Globe className="h-4 w-4" />,
  PORTAL_TASK_CREATED: <Globe className="h-4 w-4" />,
  PORTAL_TASK_COMPLETED: <CheckCircle className="h-4 w-4" />,

  // Agent/Proposal events
  GATE_TRIGGERED: <Pause className="h-4 w-4" />,
  PROPOSAL_QUEUED: <Bot className="h-4 w-4" />,
  PROPOSAL_CREATED: <Bot className="h-4 w-4" />,
  PROPOSAL_APPROVED: <CheckCircle className="h-4 w-4" />,
  PROPOSAL_DISMISSED: <XCircle className="h-4 w-4" />,
  PROPOSAL_ADJUSTED: <RotateCcw className="h-4 w-4" />,

  // Agent runs
  RUN_STARTED: <Play className="h-4 w-4" />,
  RUN_COMPLETED: <CheckCircle className="h-4 w-4" />,
  RUN_FAILED: <XCircle className="h-4 w-4" />,
  RUN_GATED: <Pause className="h-4 w-4" />,

  // Human decisions
  HUMAN_DECISION: <UserCheck className="h-4 w-4" />,
  HUMAN_APPROVAL: <CheckCircle className="h-4 w-4" />,

  // Execution events
  ACTION_EXECUTED: <Zap className="h-4 w-4" />,
  ACTION_DRY_RUN: <Shield className="h-4 w-4" />,

  // Constraint/scope events
  CONSTRAINT_DETECTED: <AlertTriangle className="h-4 w-4" />,
  SCOPE_UPDATED: <FileText className="h-4 w-4" />,

  // Status changes
  STATUS_CHANGED: <Activity className="h-4 w-4" />,
  CASE_CLOSED: <CheckCircle className="h-4 w-4" />,
  CASE_WITHDRAWN: <XCircle className="h-4 w-4" />,
};

const eventColors: Record<string, string> = {
  // Case lifecycle
  CREATED: "bg-blue-100 text-blue-800",
  SENT: "bg-green-100 text-green-800",
  RECEIVED: "bg-purple-100 text-purple-800",
  EMAIL_SENT: "bg-green-100 text-green-800",
  EMAIL_RECEIVED: "bg-purple-100 text-purple-800",

  // Fee/Cost events
  FEE_QUOTE: "bg-amber-100 text-amber-800",
  FEE_ACCEPTED: "bg-green-100 text-green-800",
  FEE_NEGOTIATED: "bg-amber-100 text-amber-800",

  // Response classifications
  DENIAL: "bg-red-100 text-red-800",
  PARTIAL_DENIAL: "bg-orange-100 text-orange-800",
  RECORDS_PROVIDED: "bg-green-100 text-green-800",

  // Follow-ups
  FOLLOW_UP: "bg-orange-100 text-orange-800",
  FOLLOWUP_SCHEDULED: "bg-orange-100 text-orange-800",
  FOLLOWUP_TRIGGERED: "bg-orange-100 text-orange-800",

  // Portal tasks
  PORTAL_TASK: "bg-cyan-100 text-cyan-800",
  PORTAL_TASK_CREATED: "bg-cyan-100 text-cyan-800",
  PORTAL_TASK_COMPLETED: "bg-teal-100 text-teal-800",

  // Agent/Proposal events
  GATE_TRIGGERED: "bg-amber-100 text-amber-800",
  PROPOSAL_QUEUED: "bg-indigo-100 text-indigo-800",
  PROPOSAL_CREATED: "bg-indigo-100 text-indigo-800",
  PROPOSAL_APPROVED: "bg-green-100 text-green-800",
  PROPOSAL_DISMISSED: "bg-gray-100 text-gray-800",
  PROPOSAL_ADJUSTED: "bg-blue-100 text-blue-800",

  // Agent runs
  RUN_STARTED: "bg-blue-100 text-blue-800",
  RUN_COMPLETED: "bg-green-100 text-green-800",
  RUN_FAILED: "bg-red-100 text-red-800",
  RUN_GATED: "bg-amber-100 text-amber-800",

  // Human decisions
  HUMAN_DECISION: "bg-green-100 text-green-800",
  HUMAN_APPROVAL: "bg-green-100 text-green-800",

  // Execution events
  ACTION_EXECUTED: "bg-green-100 text-green-800",
  ACTION_DRY_RUN: "bg-blue-100 text-blue-800",

  // Constraint/scope events
  CONSTRAINT_DETECTED: "bg-orange-100 text-orange-800",
  SCOPE_UPDATED: "bg-blue-100 text-blue-800",

  // Status changes
  STATUS_CHANGED: "bg-gray-100 text-gray-800",
  CASE_CLOSED: "bg-green-100 text-green-800",
  CASE_WITHDRAWN: "bg-red-100 text-red-800",
};

// Category filter configuration
const CATEGORY_FILTERS = [
  { id: 'MESSAGE', label: 'Messages', icon: MessageSquare, isDecisionRelevant: true },
  { id: 'STATUS', label: 'Status', icon: Activity, isDecisionRelevant: false },
  { id: 'COST', label: 'Costs', icon: DollarSign, isDecisionRelevant: true },
  { id: 'RESEARCH', label: 'Research', icon: Search, isDecisionRelevant: false },
  { id: 'AGENT', label: 'Agent', icon: Bot, isDecisionRelevant: true },
  { id: 'GATE', label: 'Gates', icon: AlertTriangle, isDecisionRelevant: true },
] as const;

type CategoryFilter = typeof CATEGORY_FILTERS[number]['id'];

// Decision-relevant event types (for default filter)
const DECISION_RELEVANT_TYPES: EventType[] = [
  'FEE_QUOTE',
  'DENIAL',
  'GATE_TRIGGERED',
  'PROPOSAL_QUEUED',
  'HUMAN_DECISION',
  'SENT',
  'RECEIVED',
];

// Get default filters (decision-relevant categories)
const getDefaultFilters = (): Set<CategoryFilter> => {
  return new Set(
    CATEGORY_FILTERS.filter((f) => f.isDecisionRelevant).map((f) => f.id)
  );
};

interface TimelineEventItemProps {
  event: TimelineEvent;
  collapsed?: boolean;
  mergedCount?: number;
}

const TimelineEventItem = memo(function TimelineEventItem({ event, collapsed, mergedCount }: TimelineEventItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex gap-3 pb-4">
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
          eventColors[event.type] || "bg-gray-100 text-gray-800"
        )}
      >
        {eventIcons[event.type] || <FileText className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{event.summary}</span>
          {mergedCount && mergedCount > 1 && (
            <Badge variant="outline" className="text-[10px]">
              <Layers className="h-2.5 w-2.5 mr-1" />
              {mergedCount} merged
            </Badge>
          )}
          {event.classification && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="text-[10px]">
                  {event.classification.type} ({Math.round(event.classification.confidence * 100)}%)
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p>Classification confidence: {Math.round(event.classification.confidence * 100)}%</p>
              </TooltipContent>
            </Tooltip>
          )}
          {event.gate_details && (
            <Badge
              variant={event.gate_details.decision_status === 'PENDING' ? 'destructive' : 'secondary'}
              className="text-[10px]"
            >
              {event.gate_details.gate_type}
              {event.gate_details.fee_amount && ` $${event.gate_details.fee_amount}`}
            </Badge>
          )}
          {(event.ai_audit || event.raw_content) && (
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

        {expanded && (
          <div className="mt-2 space-y-2">
            {/* AI Audit */}
            {event.ai_audit && (
              <Card>
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs flex items-center gap-2">
                    AI Analysis
                    {event.ai_audit.confidence !== undefined && (
                      <Badge variant="outline" className="text-[10px]">
                        {Math.round(event.ai_audit.confidence * 100)}% confident
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-2 px-3 space-y-2">
                  <ul className="text-xs space-y-1">
                    {event.ai_audit.summary.map((point, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-muted-foreground">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Statute matches with confidence */}
                  {event.ai_audit.statute_matches && event.ai_audit.statute_matches.length > 0 && (
                    <div className="pt-2 border-t">
                      <p className="text-xs text-muted-foreground mb-1">Statute Matches:</p>
                      <div className="flex flex-wrap gap-1">
                        {event.ai_audit.statute_matches.map((match, i) => (
                          <Tooltip key={i}>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="text-[10px]">
                                {match.statute}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Match confidence: {Math.round(match.confidence * 100)}%</p>
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  )}

                  {event.ai_audit.risk_flags && event.ai_audit.risk_flags.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Flags:</span>
                      {event.ai_audit.risk_flags.map((flag, i) => (
                        <Badge key={i} variant="destructive" className="text-[10px]">
                          {flag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {event.ai_audit.citations && event.ai_audit.citations.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Citations:</span>
                      {event.ai_audit.citations.map((cite, i) => (
                        <a
                          key={i}
                          href={cite.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          {cite.label}
                        </a>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Raw content preview */}
            {event.raw_content && !event.ai_audit && (
              <div className="bg-muted rounded p-2 text-xs max-h-32 overflow-auto">
                {event.raw_content.substring(0, 300)}
                {event.raw_content.length > 300 && "..."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

interface TimelineProps {
  events: TimelineEvent[];
}

export function Timeline({ events }: TimelineProps) {
  // Default to decision-relevant events
  const [activeFilters, setActiveFilters] = useState<Set<CategoryFilter>>(getDefaultFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Deduplicate and filter events
  const processedEvents = useMemo(() => {
    // First, deduplicate identical consecutive events
    const deduped: (TimelineEvent & { mergedCount?: number })[] = [];
    let lastEvent: TimelineEvent | null = null;
    let mergeCount = 1;

    for (const event of events) {
      if (
        lastEvent &&
        lastEvent.type === event.type &&
        lastEvent.summary === event.summary &&
        Math.abs(new Date(lastEvent.timestamp).getTime() - new Date(event.timestamp).getTime()) < 60000 // Within 1 minute
      ) {
        // Merge with previous
        mergeCount++;
      } else {
        if (lastEvent) {
          deduped.push({ ...lastEvent, mergedCount: mergeCount > 1 ? mergeCount : undefined });
        }
        lastEvent = event;
        mergeCount = 1;
      }
    }
    if (lastEvent) {
      deduped.push({ ...lastEvent, mergedCount: mergeCount > 1 ? mergeCount : undefined });
    }

    // Then filter by category (unless showAll is true)
    if (showAll) {
      return deduped;
    }

    return deduped.filter((e) => {
      const category = e.category || 'STATUS';
      return activeFilters.has(category as CategoryFilter);
    });
  }, [events, activeFilters, showAll]);

  const toggleFilter = useCallback((filter: CategoryFilter) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      return next;
    });
  }, []);

  if (events.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No timeline events yet
      </div>
    );
  }

  const totalEvents = events.length;
  const filteredOut = totalEvents - processedEvents.length;

  return (
    <div className="space-y-2">
      {/* Filter toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="h-3 w-3 mr-1" />
            {showAll ? 'All' : 'Decisions'}
          </Button>
          {!showAll && filteredOut > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="text-[10px] text-primary hover:underline"
            >
              +{filteredOut} more
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {processedEvents.length} event{processedEvents.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter buttons */}
      {showFilters && (
        <div className="flex flex-wrap gap-1 pb-2 border-b">
          <Button
            variant={showAll ? "default" : "outline"}
            size="sm"
            className="h-6 text-[10px] px-2"
            onClick={() => {
              setShowAll(!showAll);
              if (!showAll) {
                setActiveFilters(new Set());
              } else {
                setActiveFilters(getDefaultFilters());
              }
            }}
          >
            {showAll ? 'Show all' : 'All events'}
          </Button>
          {CATEGORY_FILTERS.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilters.has(filter.id);
            return (
              <Button
                key={filter.id}
                variant={isActive && !showAll ? "default" : "outline"}
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => {
                  setShowAll(false);
                  toggleFilter(filter.id);
                }}
                disabled={showAll}
              >
                <Icon className="h-3 w-3 mr-1" />
                {filter.label}
              </Button>
            );
          })}
          {!showAll && activeFilters.size > 0 && activeFilters.size !== getDefaultFilters().size && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => setActiveFilters(getDefaultFilters())}
            >
              Reset
            </Button>
          )}
        </div>
      )}

      {/* Events */}
      <ScrollArea className="h-[300px]">
        <div className="pr-4">
          {processedEvents.map((event) => (
            <TimelineEventItem
              key={event.id}
              event={event}
              mergedCount={event.mergedCount}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
