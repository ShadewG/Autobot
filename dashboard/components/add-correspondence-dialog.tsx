"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Phone, AlertCircle, CheckCircle2, Clock, XCircle, PlayCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface AddCorrespondenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: number;
  onSuccess?: () => void;
}

interface CorrespondenceResult {
  messageId: number;
  runId: number | null;
  runStatus: string;
  error?: string;
}

const CORRESPONDENCE_TYPES = [
  { value: "phone_call", label: "Phone Call" },
  { value: "letter", label: "Letter / Mail" },
  { value: "in_person", label: "In-Person" },
  { value: "fax", label: "Fax" },
  { value: "other", label: "Other" },
];

const DIRECTIONS = [
  { value: "inbound", label: "They contacted us" },
  { value: "outbound", label: "We contacted them" },
];

export function AddCorrespondenceDialog({
  open,
  onOpenChange,
  caseId,
  onSuccess,
}: AddCorrespondenceDialogProps) {
  const [correspondenceType, setCorrespondenceType] = useState("phone_call");
  const [direction, setDirection] = useState("inbound");
  const [contactName, setContactName] = useState("");
  const [summary, setSummary] = useState("");
  const [triggerAI, setTriggerAI] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CorrespondenceResult | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // Poll for run status when we have a run ID
  useEffect(() => {
    if (!result?.runId || !isPolling) return;

    let inflight = false;
    const pollStatus = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const response = await fetch(`/api/runs/${result.runId}`);
        if (!response.ok) return;
        const data = await response.json();
        if (data.run) {
          const newStatus = data.run.status;
          setResult(prev => prev ? { ...prev, runStatus: newStatus, error: data.run.error_message } : null);
          if (['completed', 'failed', 'paused', 'gated', 'skipped'].includes(newStatus)) {
            setIsPolling(false);
          }
        }
      } catch (err) {
        console.error('Error polling run status:', err);
      } finally {
        inflight = false;
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [result?.runId, isPolling]);

  const handleSubmit = async () => {
    if (summary.trim().length < 10) {
      setError('Please provide a more detailed summary (at least 10 characters)');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`/api/cases/${caseId}/add-correspondence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correspondence_type: correspondenceType,
          direction,
          summary: summary.trim(),
          contact_name: contactName.trim() || undefined,
          trigger_ai: triggerAI,
        }),
      });

      const data = await response.json();

      if (response.status === 409) {
        if (data.reason === 'active_run') {
          setError(data.error || 'Case has an active run. Wait for it to complete.');
        } else {
          setResult({
            messageId: data.existing_message_id || 0,
            runId: null,
            runStatus: 'duplicate',
            error: data.error || 'Duplicate correspondence already logged'
          });
        }
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to log correspondence');
      }

      setResult({
        messageId: data.inbound_message_id,
        runId: data.run?.id || null,
        runStatus: data.run?.status || 'no_run'
      });

      if (data.run?.id) {
        setIsPolling(true);
      }

      // Reset form but keep dialog open for status
      setSummary("");
      setContactName("");

      onSuccess?.();
    } catch (err: any) {
      console.error('Error logging correspondence:', err);
      setError(err.message || 'Failed to log correspondence');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setCorrespondenceType("phone_call");
    setDirection("inbound");
    setContactName("");
    setSummary("");
    setTriggerAI(true);
    setError(null);
    setResult(null);
    setIsPolling(false);
    onOpenChange(false);
  };

  const getStatusDisplay = (status: string) => {
    switch (status) {
      case 'queued':
      case 'running':
        return { icon: <Loader2 className="h-4 w-4 animate-spin" />, text: 'Processing...', color: 'text-blue-600' };
      case 'completed':
        return { icon: <CheckCircle2 className="h-4 w-4" />, text: 'Completed', color: 'text-green-600' };
      case 'paused':
      case 'gated':
        return { icon: <Clock className="h-4 w-4" />, text: 'Needs Review', color: 'text-amber-600' };
      case 'failed':
        return { icon: <XCircle className="h-4 w-4" />, text: 'Failed', color: 'text-red-600' };
      case 'duplicate':
        return { icon: <AlertCircle className="h-4 w-4" />, text: 'Duplicate', color: 'text-amber-600' };
      case 'no_run':
        return { icon: <PlayCircle className="h-4 w-4" />, text: 'Logged (no AI run)', color: 'text-gray-600' };
      default:
        return { icon: <Clock className="h-4 w-4" />, text: status, color: 'text-gray-600' };
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Add Correspondence
          </DialogTitle>
          <DialogDescription>
            Log a phone call, letter, or other interaction. The AI can suggest next steps based on what happened.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <Alert variant={result.runStatus === 'failed' ? 'destructive' : 'default'} className="bg-muted">
            <AlertTitle className="flex items-center gap-2">
              {(() => {
                const status = getStatusDisplay(result.runStatus);
                return (
                  <>
                    <span className={status.color}>{status.icon}</span>
                    <span>Correspondence Logged - {status.text}</span>
                  </>
                );
              })()}
            </AlertTitle>
            <AlertDescription className="mt-2 space-y-1 text-sm">
              <div className="font-mono">
                <span className="text-muted-foreground">Message ID:</span> {result.messageId}
              </div>
              {result.runId && (
                <div className="font-mono">
                  <span className="text-muted-foreground">Run ID:</span> {result.runId}
                </div>
              )}
              {result.error && (
                <div className="font-mono text-red-600">
                  <span className="text-muted-foreground">Error:</span> {result.error}
                </div>
              )}
              {isPolling && (
                <div className="text-xs text-muted-foreground mt-2">
                  Checking status every 2 seconds...
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="corr-type">Type</Label>
              <select
                id="corr-type"
                value={correspondenceType}
                onChange={(e) => setCorrespondenceType(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {CORRESPONDENCE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="corr-direction">Direction</Label>
              <select
                id="corr-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {DIRECTIONS.map(d => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="corr-contact">Contact Name (optional)</Label>
            <Input
              id="corr-contact"
              placeholder="e.g. John Smith, Records Dept"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="corr-summary">Summary *</Label>
            <Textarea
              id="corr-summary"
              placeholder="Describe what happened, what was discussed, and the outcome..."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="min-h-[120px]"
            />
            {summary.length > 0 && summary.length < 10 && (
              <p className="text-xs text-muted-foreground">{10 - summary.length} more characters needed</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="corr-trigger-ai"
              checked={triggerAI}
              onChange={(e) => setTriggerAI(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <Label htmlFor="corr-trigger-ai" className="text-sm font-normal cursor-pointer">
              Get AI recommendation for next steps
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || summary.trim().length < 10}
            className="bg-green-600 hover:bg-green-700"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Logging...
              </>
            ) : (
              <>
                <Phone className="h-4 w-4 mr-1" />
                Log Correspondence
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
