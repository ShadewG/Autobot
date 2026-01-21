"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { NextAction } from "@/lib/types";
import {
  Send,
  Edit,
  Trash2,
  AlertTriangle,
  CheckCircle,
  Clock,
  Globe,
  Mail,
  DollarSign,
  Loader2,
  ChevronRight,
  Shield,
  Zap,
  CalendarClock,
  ArrowRight,
  Scale,
} from "lucide-react";

interface ActionPreview {
  steps: Array<{
    action: string;
    detail: string;
    icon: React.ReactNode;
  }>;
  executionMode: "DRY" | "LIVE";
  estimatedFollowup?: {
    date: string;
    sequence: number;
  };
}

interface DraftApprovalPanelProps {
  action: NextAction | null;
  executionMode: "DRY" | "LIVE";
  isPortalAgency?: boolean;
  onApprove: (editedContent?: { subject?: string; body?: string }) => void;
  onDismiss: () => void;
  onEscalate?: () => void;
  isLoading?: boolean;
}

// Build action preview based on action type
function buildActionPreview(
  action: NextAction | null,
  executionMode: "DRY" | "LIVE",
  isPortalAgency: boolean
): ActionPreview {
  const steps: ActionPreview["steps"] = [];

  if (!action) {
    return { steps: [], executionMode };
  }

  // Step 1: Create execution record
  steps.push({
    action: "Create execution record",
    detail: `Proposal #${action.id} marked as approved`,
    icon: <CheckCircle className="h-4 w-4 text-green-500" />,
  });

  // Step 2: Execute action based on type
  if (isPortalAgency) {
    steps.push({
      action: "Create portal task",
      detail: "Manual submission task will be created for team",
      icon: <Globe className="h-4 w-4 text-cyan-500" />,
    });
  } else {
    const sendAction = executionMode === "LIVE"
      ? "Send email via SendGrid"
      : "Skip sending (DRY mode)";
    steps.push({
      action: sendAction,
      detail: executionMode === "LIVE"
        ? `Email will be sent to agency`
        : "No actual email will be sent",
      icon: executionMode === "LIVE"
        ? <Send className="h-4 w-4 text-green-500" />
        : <Shield className="h-4 w-4 text-blue-500" />,
    });
  }

  // Step 3: Schedule follow-up (if applicable)
  if (action.action_type !== "WITHDRAWAL") {
    steps.push({
      action: "Schedule follow-up",
      detail: "Follow-up #1 scheduled in 14 days",
      icon: <CalendarClock className="h-4 w-4 text-orange-500" />,
    });
  }

  // Step 4: Update case status
  steps.push({
    action: "Update case status",
    detail: action.action_type === "WITHDRAWAL" ? "Case will be closed" : "Status updated to AWAITING_RESPONSE",
    icon: <CheckCircle className="h-4 w-4 text-blue-500" />,
  });

  return {
    steps,
    executionMode,
    estimatedFollowup: action.action_type !== "WITHDRAWAL"
      ? {
          date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          sequence: 1,
        }
      : undefined,
  };
}

const ACTION_TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  SEND_EMAIL: { label: "Send Email", icon: <Mail className="h-4 w-4" />, color: "text-blue-600" },
  SEND_REPLY: { label: "Send Reply", icon: <Mail className="h-4 w-4" />, color: "text-blue-600" },
  ACCEPT_FEE: { label: "Accept Fee", icon: <DollarSign className="h-4 w-4" />, color: "text-green-600" },
  NEGOTIATE_FEE: { label: "Negotiate Fee", icon: <DollarSign className="h-4 w-4" />, color: "text-amber-600" },
  APPEAL: { label: "Appeal", icon: <Scale className="h-4 w-4" />, color: "text-orange-600" },
  NARROW_SCOPE: { label: "Narrow & Retry", icon: <Edit className="h-4 w-4" />, color: "text-purple-600" },
  FOLLOW_UP: { label: "Follow Up", icon: <Clock className="h-4 w-4" />, color: "text-gray-600" },
  WITHDRAWAL: { label: "Withdraw", icon: <Trash2 className="h-4 w-4" />, color: "text-red-600" },
};

export function DraftApprovalPanel({
  action,
  executionMode,
  isPortalAgency = false,
  onApprove,
  onDismiss,
  onEscalate,
  isLoading,
}: DraftApprovalPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedSubject, setEditedSubject] = useState(action?.draft_subject || "");
  const [editedBody, setEditedBody] = useState(action?.draft_body || "");

  const actionConfig = action?.action_type
    ? ACTION_TYPE_CONFIG[action.action_type] || { label: action.action_type, icon: <Mail className="h-4 w-4" />, color: "text-gray-600" }
    : null;

  const preview = buildActionPreview(action, executionMode, isPortalAgency);

  if (!action) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recommended Action</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No action recommended
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleApprove = () => {
    if (isEditing) {
      onApprove({
        subject: editedSubject !== action.draft_subject ? editedSubject : undefined,
        body: editedBody !== action.draft_body ? editedBody : undefined,
      });
    } else {
      onApprove();
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {actionConfig?.icon}
            Recommended: {actionConfig?.label}
          </CardTitle>
          {action.confidence && (
            <Badge variant="outline" className="text-xs">
              {Math.round(action.confidence * 100)}% confidence
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Execution Mode Warning */}
        <Alert
          className={cn(
            executionMode === "LIVE"
              ? "border-red-200 bg-red-50"
              : "border-blue-200 bg-blue-50"
          )}
        >
          {executionMode === "LIVE" ? (
            <Zap className="h-4 w-4 text-red-600" />
          ) : (
            <Shield className="h-4 w-4 text-blue-600" />
          )}
          <AlertTitle
            className={cn(
              "text-sm",
              executionMode === "LIVE" ? "text-red-700" : "text-blue-700"
            )}
          >
            {executionMode === "LIVE" ? "LIVE EXECUTION" : "DRY RUN MODE"}
          </AlertTitle>
          <AlertDescription
            className={cn(
              "text-xs",
              executionMode === "LIVE" ? "text-red-600" : "text-blue-600"
            )}
          >
            {executionMode === "LIVE"
              ? "Approving will trigger real email sending and case updates"
              : "No actual emails will be sent - execution is simulated"}
          </AlertDescription>
        </Alert>

        {/* Portal Agency Notice */}
        {isPortalAgency && (
          <Alert className="border-cyan-200 bg-cyan-50">
            <Globe className="h-4 w-4 text-cyan-600" />
            <AlertTitle className="text-sm text-cyan-700">Portal Agency</AlertTitle>
            <AlertDescription className="text-xs text-cyan-600">
              This agency requires portal submission. A portal task will be created instead of sending email.
            </AlertDescription>
          </Alert>
        )}

        {/* Reasoning */}
        {action.reasoning && action.reasoning.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Why this action?</p>
            <ul className="text-sm space-y-1">
              {action.reasoning.map((r, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-muted-foreground">•</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Warnings */}
        {action.warnings && action.warnings.length > 0 && (
          <Alert className="border-amber-200 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertTitle className="text-sm text-amber-700">Warnings</AlertTitle>
            <AlertDescription className="text-xs text-amber-600">
              <ul className="mt-1 space-y-1">
                {action.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <Separator />

        {/* Draft Content */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Draft {isPortalAgency ? "Instructions" : "Email"}</p>
            {!isEditing && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setIsEditing(true);
                  setEditedSubject(action.draft_subject || "");
                  setEditedBody(action.draft_body || "");
                }}
              >
                <Edit className="h-3 w-3 mr-1" />
                Edit
              </Button>
            )}
          </div>

          {isEditing ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Subject</Label>
                <Input
                  value={editedSubject}
                  onChange={(e) => setEditedSubject(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Body</Label>
                <Textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="mt-1 min-h-[200px] font-mono text-sm"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {action.draft_subject && (
                <p className="text-sm">
                  <span className="text-muted-foreground">Subject:</span>{" "}
                  <span className="font-medium">{action.draft_subject}</span>
                </p>
              )}
              <div className="bg-muted/50 rounded-lg p-3 max-h-[200px] overflow-auto">
                <pre className="text-sm whitespace-pre-wrap font-sans">
                  {action.draft_body || "(No content)"}
                </pre>
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* Action Preview - What Happens Next */}
        <div>
          <p className="text-sm font-medium mb-3 flex items-center gap-2">
            <ArrowRight className="h-4 w-4" />
            What happens if you approve:
          </p>
          <div className="space-y-2">
            {preview.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <div className="mt-0.5">{step.icon}</div>
                <div>
                  <p className="font-medium">{step.action}</p>
                  <p className="text-xs text-muted-foreground">{step.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Separator />

        {/* Action Buttons */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={handleApprove}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : isPortalAgency ? (
                <Globe className="h-4 w-4 mr-1" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {isEditing ? "Save & Approve" : "Approve & Execute"}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onDismiss}
              disabled={isLoading}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Dismiss
            </Button>
            {onEscalate && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={onEscalate}
                disabled={isLoading}
              >
                <AlertTriangle className="h-4 w-4 mr-1" />
                Escalate
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
