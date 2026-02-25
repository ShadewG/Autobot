"use client";

import { useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetcher, casesAPI } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  Clock,
  Calendar,
  Play,
  Pause,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronRight,
  RefreshCw,
} from "lucide-react";

interface FollowUpSchedule {
  id: number;
  case_id: number;
  followup_count: number;
  max_followups: number;
  interval_days: number;
  next_followup_date: string | null;
  status: 'active' | 'paused' | 'completed' | 'max_reached';
  last_run_id?: number;
  last_run_status?: string;
  last_run_error?: string;
  created_at: string;
  updated_at: string;
}

interface FollowupSchedulerPanelProps {
  caseId: number;
  onTriggerFollowup?: () => void;
}

export function FollowupSchedulerPanel({
  caseId,
  onTriggerFollowup,
}: FollowupSchedulerPanelProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch follow-up schedule for this case
  const { data, error, mutate } = useSWR<{ success: boolean; schedule: FollowUpSchedule | null }>(
    `/cases/${caseId}/followup-schedule`,
    fetcher,
    { refreshInterval: 60000 }
  );

  const schedule = data?.schedule;

  const handleTogglePause = async () => {
    if (!schedule) return;
    setIsSubmitting(true);
    try {
      const newStatus = schedule.status === 'paused' ? 'active' : 'paused';
      await fetch(`/api/cases/${caseId}/followup-schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      mutate();
    } catch (error) {
      console.error("Error toggling pause:", error);
      alert("Failed to update follow-up status");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTriggerNow = async () => {
    setIsSubmitting(true);
    try {
      await casesAPI.runFollowup(caseId, { autopilotMode: 'SUPERVISED' });
      mutate();
      onTriggerFollowup?.();
    } catch (error: any) {
      console.error("Error triggering follow-up:", error);
      alert(error.message || "Failed to trigger follow-up");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getStatusIcon = () => {
    if (!schedule) return null;
    switch (schedule.status) {
      case 'active':
        return <Clock className="h-4 w-4 text-green-500" />;
      case 'paused':
        return <Pause className="h-4 w-4 text-amber-500" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'max_reached':
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };

  const getStatusColor = () => {
    if (!schedule) return "";
    switch (schedule.status) {
      case 'active':
        return "bg-green-500/15 text-green-300";
      case 'paused':
        return "bg-amber-500/15 text-amber-300";
      case 'completed':
        return "bg-green-500/15 text-green-300";
      case 'max_reached':
        return "bg-red-500/15 text-red-300";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground text-center">
            Failed to load follow-up schedule
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!schedule) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Follow-ups
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No follow-up schedule configured
          </p>
        </CardContent>
      </Card>
    );
  }

  const isMaxReached = schedule.followup_count >= schedule.max_followups;
  const isPaused = schedule.status === 'paused';
  const isCompleted = schedule.status === 'completed';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Follow-ups
          </CardTitle>
          <Badge className={cn("gap-1", getStatusColor())}>
            {getStatusIcon()}
            {schedule.status.replace('_', ' ')}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-2xl font-bold">
              {schedule.followup_count}
              <span className="text-lg text-muted-foreground font-normal">
                /{schedule.max_followups}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">follow-ups sent</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-medium">{schedule.interval_days} days</p>
            <p className="text-xs text-muted-foreground">between follow-ups</p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-muted rounded-full h-2">
          <div
            className={cn(
              "h-2 rounded-full transition-all",
              isMaxReached ? "bg-red-500" : "bg-green-500"
            )}
            style={{ width: `${(schedule.followup_count / schedule.max_followups) * 100}%` }}
          />
        </div>

        {/* Max Reached Warning */}
        {isMaxReached && (
          <div className="bg-red-500/10 border border-red-700/50 rounded-lg p-3">
            <p className="text-sm font-medium text-red-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Max Attempts Reached
            </p>
            <p className="text-xs text-red-400 mt-1">
              No more automatic follow-ups will be sent. Consider manual escalation.
            </p>
          </div>
        )}

        {/* Next Follow-up */}
        {!isMaxReached && !isCompleted && schedule.next_followup_date && (
          <div className="bg-muted/50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Next follow-up:</span>
              </div>
              <span className="text-sm font-medium">
                {formatDate(schedule.next_followup_date)}
              </span>
            </div>
            {isPaused && (
              <p className="text-xs text-amber-400 mt-1">
                Paused - will not send until resumed
              </p>
            )}
          </div>
        )}

        {/* Last Run Info */}
        {schedule.last_run_id && (
          <div className="text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>Last run: #{schedule.last_run_id}</span>
              <Badge
                variant={schedule.last_run_status === 'completed' ? 'default' : 'destructive'}
                className="text-[10px]"
              >
                {schedule.last_run_status}
              </Badge>
            </div>
            {schedule.last_run_error && (
              <p className="text-red-500 mt-1 truncate">
                Error: {schedule.last_run_error}
              </p>
            )}
          </div>
        )}

        <Separator />

        {/* Controls */}
        <div className="space-y-3">
          {/* Pause/Resume Toggle */}
          {!isMaxReached && !isCompleted && (
            <div className="flex items-center justify-between">
              <Label htmlFor="pause-followups" className="text-sm">
                {isPaused ? "Follow-ups paused" : "Follow-ups active"}
              </Label>
              <Switch
                id="pause-followups"
                checked={!isPaused}
                onCheckedChange={handleTogglePause}
                disabled={isSubmitting}
              />
            </div>
          )}

          {/* Trigger Now Button */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleTriggerNow}
                    disabled={isSubmitting || isMaxReached}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-1" />
                    )}
                    Trigger Now
                  </Button>
                </div>
              </TooltipTrigger>
              {isMaxReached && (
                <TooltipContent>
                  <p>Max follow-ups reached</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </CardContent>
    </Card>
  );
}
