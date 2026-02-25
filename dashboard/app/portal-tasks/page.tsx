"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetcher,
  portalTasksAPI,
  type PortalTask,
  type PortalTasksListResponse,
} from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Globe,
  ExternalLink,
  Play,
  RefreshCw,
  Copy,
  Upload,
  FileText,
  ChevronRight,
  User,
} from "lucide-react";

const TASK_TYPE_CONFIG: Record<PortalTask['task_type'], { icon: React.ReactNode; label: string; color: string }> = {
  initial_submission: { icon: <Upload className="h-4 w-4" />, label: "Initial Submission", color: "text-blue-400 bg-blue-500/10" },
  fee_payment: { icon: <FileText className="h-4 w-4" />, label: "Fee Payment", color: "text-green-400 bg-green-500/10" },
  document_upload: { icon: <Upload className="h-4 w-4" />, label: "Document Upload", color: "text-purple-400 bg-purple-500/10" },
  status_check: { icon: <Clock className="h-4 w-4" />, label: "Status Check", color: "text-muted-foreground bg-muted" },
};

const STATUS_CONFIG: Record<PortalTask['status'], { icon: React.ReactNode; label: string; color: string }> = {
  pending: { icon: <Clock className="h-4 w-4" />, label: "Pending", color: "text-amber-400 bg-amber-500/10" },
  in_progress: { icon: <Play className="h-4 w-4" />, label: "In Progress", color: "text-blue-400 bg-blue-500/10" },
  completed: { icon: <CheckCircle className="h-4 w-4" />, label: "Completed", color: "text-green-400 bg-green-500/10" },
  failed: { icon: <XCircle className="h-4 w-4" />, label: "Failed", color: "text-red-400 bg-red-500/10" },
  cancelled: { icon: <XCircle className="h-4 w-4" />, label: "Cancelled", color: "text-muted-foreground bg-muted" },
};

export default function PortalTasksPage() {
  const [selectedTask, setSelectedTask] = useState<PortalTask | null>(null);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [completionNotes, setCompletionNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<PortalTasksListResponse>(
    "/portal-tasks",
    fetcher,
    { refreshInterval: 30000 }
  );

  const handleClaim = async (task: PortalTask) => {
    setIsSubmitting(true);
    try {
      await portalTasksAPI.claim(task.id);
      mutate();
    } catch (error) {
      console.error("Error claiming task:", error);
      alert("Failed to claim task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleComplete = async () => {
    if (!selectedTask) return;
    setIsSubmitting(true);
    try {
      await portalTasksAPI.complete(selectedTask.id, {
        confirmation_number: confirmationNumber || undefined,
        notes: completionNotes || undefined,
      });
      mutate();
      setShowCompleteModal(false);
      setSelectedTask(null);
      setConfirmationNumber("");
      setCompletionNotes("");
    } catch (error) {
      console.error("Error completing task:", error);
      alert("Failed to complete task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async (task: PortalTask, reason?: string) => {
    if (!confirm("Are you sure you want to cancel this task?")) return;
    setIsSubmitting(true);
    try {
      await portalTasksAPI.cancel(task.id, reason);
      mutate();
      setSelectedTask(null);
    } catch (error) {
      console.error("Error cancelling task:", error);
      alert("Failed to cancel task");
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyPayload = (payload: Record<string, unknown>) => {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  const tasks = data?.tasks || [];
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load portal tasks</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Globe className="h-6 w-6" />
            Portal Tasks
          </h1>
          <p className="text-sm text-muted-foreground">
            Manual portal submission tasks requiring human action
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-lg px-3 py-1">
            {pendingTasks.length} pending
          </Badge>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4">
        {(['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const).map((status) => {
          const count = tasks.filter(t => t.status === status).length;
          const config = STATUS_CONFIG[status];
          return (
            <Card key={status}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{config.label}</p>
                    <p className="text-2xl font-bold">{count}</p>
                  </div>
                  <div className={cn("p-2 rounded-full", config.color)}>
                    {config.icon}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : pendingTasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
            <h3 className="text-lg font-semibold">No pending tasks</h3>
            <p className="text-muted-foreground">All portal tasks are complete</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Tasks List */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pending Tasks</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[500px]">
                <div className="divide-y">
                  {pendingTasks.map((task) => {
                    const typeConfig = TASK_TYPE_CONFIG[task.task_type];
                    const statusConfig = STATUS_CONFIG[task.status];

                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "p-4 cursor-pointer hover:bg-muted/50 transition-colors",
                          selectedTask?.id === task.id && "bg-muted"
                        )}
                        onClick={() => setSelectedTask(task)}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">
                              {task.case_name || `Case #${task.case_id}`}
                            </p>
                            <p className="text-sm text-muted-foreground truncate">
                              {task.agency_name}
                            </p>
                          </div>
                          <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={cn("gap-1 text-xs", typeConfig.color)}>
                            {typeConfig.icon}
                            {typeConfig.label}
                          </Badge>
                          <Badge variant="outline" className={cn("gap-1 text-xs", statusConfig.color)}>
                            {statusConfig.icon}
                            {statusConfig.label}
                          </Badge>
                          {task.assigned_to && (
                            <Badge variant="outline" className="text-xs gap-1">
                              <User className="h-3 w-3" />
                              {task.assigned_to}
                            </Badge>
                          )}
                        </div>

                        <p className="text-xs text-muted-foreground mt-2">
                          Created: {formatDate(task.created_at)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Task Detail */}
          <Card>
            {selectedTask ? (
              <>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Task Details</CardTitle>
                    <Link
                      href={`/requests/detail?id=${selectedTask.case_id}`}
                      className="text-sm text-primary hover:underline"
                    >
                      View Case
                    </Link>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Case Info */}
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="font-medium">{selectedTask.case_name || `Case #${selectedTask.case_id}`}</p>
                    <p className="text-sm text-muted-foreground">{selectedTask.agency_name}</p>
                  </div>

                  {/* Portal URL */}
                  {selectedTask.portal_url && (
                    <div>
                      <p className="text-sm font-medium mb-2">Portal URL:</p>
                      <div className="flex items-center gap-2">
                        <Input value={selectedTask.portal_url} readOnly className="font-mono text-sm" />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(selectedTask.portal_url, '_blank')}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Instructions */}
                  {selectedTask.instructions && (
                    <div>
                      <p className="text-sm font-medium mb-2">Instructions:</p>
                      <div className="bg-blue-500/10 border border-blue-700/50 rounded-lg p-3">
                        <p className="text-sm whitespace-pre-wrap">{selectedTask.instructions}</p>
                      </div>
                    </div>
                  )}

                  {/* Payload */}
                  {selectedTask.payload && Object.keys(selectedTask.payload).length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium">Payload Data:</p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => copyPayload(selectedTask.payload!)}
                        >
                          <Copy className="h-4 w-4 mr-1" />
                          {copiedPayload ? "Copied!" : "Copy"}
                        </Button>
                      </div>
                      <pre className="bg-muted rounded-lg p-3 text-xs overflow-auto max-h-[200px]">
                        {JSON.stringify(selectedTask.payload, null, 2)}
                      </pre>
                    </div>
                  )}

                  <Separator />

                  {/* Actions */}
                  <div className="space-y-2">
                    {selectedTask.status === 'pending' && (
                      <Button
                        className="w-full"
                        onClick={() => handleClaim(selectedTask)}
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

                    {selectedTask.status === 'in_progress' && (
                      <>
                        <Button
                          className="w-full"
                          onClick={() => setShowCompleteModal(true)}
                          disabled={isSubmitting}
                        >
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Mark Complete
                        </Button>
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => handleCancel(selectedTask, "Unable to complete")}
                          disabled={isSubmitting}
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Cancel Task
                        </Button>
                      </>
                    )}

                    {selectedTask.portal_url && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => window.open(selectedTask.portal_url, '_blank')}
                      >
                        <ExternalLink className="h-4 w-4 mr-1" />
                        Open Portal
                      </Button>
                    )}
                  </div>
                </CardContent>
              </>
            ) : (
              <CardContent className="py-12 text-center">
                <Globe className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">Select a task to view details</p>
              </CardContent>
            )}
          </Card>
        </div>
      )}

      {/* Complete Modal */}
      <Dialog open={showCompleteModal} onOpenChange={setShowCompleteModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete Task</DialogTitle>
            <DialogDescription>
              Mark this portal task as completed
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium">Confirmation Number (optional)</label>
              <Input
                placeholder="e.g., FOIA-2024-12345"
                value={confirmationNumber}
                onChange={(e) => setConfirmationNumber(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Notes (optional)</label>
              <Textarea
                placeholder="Any additional notes about the submission..."
                value={completionNotes}
                onChange={(e) => setCompletionNotes(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCompleteModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleComplete} disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-1" />
              )}
              Complete Task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
