"use client";

import { useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fetcher, portalTasksAPI, type PortalTask } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  Globe,
  ExternalLink,
  User,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  Copy,
  Upload,
  ChevronDown,
  ChevronRight,
  Play,
  Image,
} from "lucide-react";

interface PortalTaskPanelProps {
  caseId: number;
  portalUrl?: string;
  onTaskComplete?: () => void;
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  pending: { icon: <Clock className="h-4 w-4" />, color: "bg-amber-500/15 text-amber-300", label: "Pending" },
  in_progress: { icon: <Play className="h-4 w-4" />, color: "bg-blue-500/15 text-blue-300", label: "In Progress" },
  completed: { icon: <CheckCircle className="h-4 w-4" />, color: "bg-green-500/15 text-green-300", label: "Completed" },
  failed: { icon: <XCircle className="h-4 w-4" />, color: "bg-red-500/15 text-red-300", label: "Failed" },
  cancelled: { icon: <XCircle className="h-4 w-4" />, color: "bg-muted text-muted-foreground", label: "Cancelled" },
};

export function PortalTaskPanel({
  caseId,
  portalUrl,
  onTaskComplete,
}: PortalTaskPanelProps) {
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [completionNotes, setCompletionNotes] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Fetch portal tasks for this case
  const { data, error, mutate } = useSWR<{ tasks: PortalTask[] }>(
    `/portal-tasks/case/${caseId}`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const tasks = data?.tasks || [];
  const activeTask = tasks.find(t => t.status === 'pending' || t.status === 'in_progress');
  const completedTasks = tasks.filter(t => t.status === 'completed');

  const handleClaim = async () => {
    if (!activeTask) return;
    setIsSubmitting(true);
    try {
      await portalTasksAPI.claim(activeTask.id);
      mutate();
    } catch (error) {
      console.error("Error claiming task:", error);
      alert("Failed to claim task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleComplete = async () => {
    if (!activeTask) return;
    setIsSubmitting(true);
    try {
      await portalTasksAPI.complete(activeTask.id, {
        confirmation_number: confirmationNumber || undefined,
        notes: completionNotes || undefined,
        attachments: screenshotUrl ? [screenshotUrl] : undefined,
      });
      mutate();
      onTaskComplete?.();
      setShowCompleteForm(false);
      setConfirmationNumber("");
      setCompletionNotes("");
      setScreenshotUrl("");
    } catch (error) {
      console.error("Error completing task:", error);
      alert("Failed to complete task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground text-center">
            Failed to load portal tasks
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Portal Task
          </CardTitle>
          {portalUrl && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => window.open(portalUrl, '_blank')}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              Open Portal
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!activeTask && completedTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No portal tasks for this case
          </p>
        ) : activeTask ? (
          <>
            {/* Task Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge className={cn("gap-1", STATUS_CONFIG[activeTask.status]?.color)}>
                  {STATUS_CONFIG[activeTask.status]?.icon}
                  {STATUS_CONFIG[activeTask.status]?.label}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {activeTask.task_type.replace(/_/g, ' ')}
                </Badge>
              </div>
              {activeTask.assigned_to && (
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <User className="h-3 w-3" />
                  {activeTask.assigned_to}
                </div>
              )}
            </div>

            {/* Task Instructions */}
            {activeTask.instructions && (
              <div className="bg-blue-500/10 border border-blue-700/50 rounded-lg p-3">
                <p className="text-sm font-medium text-blue-300 mb-1">Instructions:</p>
                <p className="text-sm text-blue-300 whitespace-pre-wrap">
                  {activeTask.instructions}
                </p>
              </div>
            )}

            {/* Payload Fields to Copy */}
            {activeTask.payload && Object.keys(activeTask.payload).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Fields to Enter:</p>
                <div className="space-y-2">
                  {Object.entries(activeTask.payload).map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between bg-muted/50 rounded p-2"
                    >
                      <div>
                        <p className="text-xs text-muted-foreground capitalize">
                          {key.replace(/_/g, ' ')}
                        </p>
                        <p className="text-sm font-mono">{String(value)}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => copyToClipboard(String(value), key)}
                      >
                        {copiedField === key ? (
                          <CheckCircle className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Separator />

            {/* Actions */}
            {activeTask.status === 'pending' && (
              <Button
                className="w-full"
                onClick={handleClaim}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-1" />
                )}
                Claim Task
              </Button>
            )}

            {activeTask.status === 'in_progress' && !showCompleteForm && (
              <div className="space-y-2">
                <Button
                  className="w-full"
                  onClick={() => setShowCompleteForm(true)}
                >
                  <CheckCircle className="h-4 w-4 mr-1" />
                  Mark Complete
                </Button>
                {portalUrl && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => window.open(portalUrl, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Open Portal
                  </Button>
                )}
              </div>
            )}

            {/* Complete Form */}
            {showCompleteForm && (
              <div className="space-y-3 bg-muted/50 rounded-lg p-3">
                <p className="text-sm font-medium">Complete Task</p>
                <div>
                  <Label className="text-xs">Confirmation Number</Label>
                  <Input
                    placeholder="e.g., FOIA-2024-12345"
                    value={confirmationNumber}
                    onChange={(e) => setConfirmationNumber(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Screenshot URL (optional)</Label>
                  <Input
                    placeholder="https://..."
                    value={screenshotUrl}
                    onChange={(e) => setScreenshotUrl(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Notes (optional)</Label>
                  <Textarea
                    placeholder="Any additional notes..."
                    value={completionNotes}
                    onChange={(e) => setCompletionNotes(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setShowCompleteForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleComplete}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle className="h-4 w-4 mr-1" />
                    )}
                    Complete
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : null}

        {/* Completed Tasks History */}
        {completedTasks.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start h-7 text-xs">
                <ChevronRight className="h-3 w-3 mr-1 transition-transform" />
                {completedTasks.length} completed task{completedTasks.length !== 1 ? 's' : ''}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2 pt-2">
                {completedTasks.map((task) => (
                  <div key={task.id} className="bg-green-500/10 rounded p-2 text-sm">
                    <div className="flex items-center justify-between">
                      <Badge className="bg-green-500/15 text-green-300 text-xs">
                        {task.task_type.replace(/_/g, ' ')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(task.completed_at || task.updated_at)}
                      </span>
                    </div>
                    {task.completion_notes && (
                      <p className="text-xs text-green-300 mt-1">
                        {task.completion_notes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
