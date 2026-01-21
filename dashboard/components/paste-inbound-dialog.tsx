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
import { Loader2, Mail, ClipboardPaste, AlertCircle, CheckCircle2, Clock, XCircle, PlayCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface PasteInboundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: number;
  onSuccess?: () => void;
}

interface ParsedEmail {
  from: string;
  subject: string;
  body: string;
  date?: string;
}

interface IngestResult {
  messageId: number;
  runId: number | null;
  runStatus: string;
  error?: string;
}

function parseEmailFromClipboard(text: string): ParsedEmail {
  const lines = text.split('\n');
  const result: ParsedEmail = {
    from: '',
    subject: '',
    body: '',
    date: '',
  };

  let bodyStartIndex = 0;

  // Try to extract headers from pasted email
  for (let i = 0; i < lines.length && i < 20; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    if (lowerLine.startsWith('from:')) {
      result.from = line.substring(5).trim();
      bodyStartIndex = i + 1;
    } else if (lowerLine.startsWith('subject:')) {
      result.subject = line.substring(8).trim();
      bodyStartIndex = i + 1;
    } else if (lowerLine.startsWith('date:') || lowerLine.startsWith('sent:')) {
      const colonIndex = line.indexOf(':');
      result.date = line.substring(colonIndex + 1).trim();
      bodyStartIndex = i + 1;
    } else if (line.trim() === '' && (result.from || result.subject)) {
      // Empty line after headers indicates body start
      bodyStartIndex = i + 1;
      break;
    }
  }

  // Rest is body
  result.body = lines.slice(bodyStartIndex).join('\n').trim();

  // If no headers found, treat entire text as body
  if (!result.from && !result.subject && !result.body) {
    result.body = text.trim();
  }

  return result;
}

export function PasteInboundDialog({
  open,
  onOpenChange,
  caseId,
  onSuccess,
}: PasteInboundDialogProps) {
  const [fromEmail, setFromEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [rawPaste, setRawPaste] = useState("");
  const [showRawPaste, setShowRawPaste] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // Poll for run status when we have a run ID
  useEffect(() => {
    if (!result?.runId || !isPolling) return;

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/runs/${result.runId}`);
        const data = await response.json();
        if (data.run) {
          const newStatus = data.run.status;
          setResult(prev => prev ? { ...prev, runStatus: newStatus, error: data.run.error_message } : null);

          // Stop polling when run reaches terminal state
          if (['completed', 'failed', 'paused', 'gated', 'skipped'].includes(newStatus)) {
            setIsPolling(false);
          }
        }
      } catch (err) {
        console.error('Error polling run status:', err);
      }
    };

    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [result?.runId, isPolling]);

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setRawPaste(text);
      const parsed = parseEmailFromClipboard(text);
      setFromEmail(parsed.from);
      setSubject(parsed.subject);
      setBody(parsed.body);
      setShowRawPaste(false);
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      setError('Unable to read from clipboard. Please paste manually.');
    }
  };

  const handleRawPasteChange = (value: string) => {
    setRawPaste(value);
    const parsed = parseEmailFromClipboard(value);
    setFromEmail(parsed.from);
    setSubject(parsed.subject);
    setBody(parsed.body);
  };

  const handleSubmit = async () => {
    if (!fromEmail.trim() || !body.trim()) {
      setError('From email and body are required');
      return;
    }

    // Basic email validation
    if (!fromEmail.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`/api/cases/${caseId}/ingest-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_email: fromEmail.trim(),
          subject: subject.trim() || '(No subject)',
          body_text: body.trim(),
          received_at: new Date().toISOString(),
          source: 'manual_paste',
        }),
      });

      const data = await response.json();

      // Handle duplicate detection (409)
      if (response.status === 409) {
        setResult({
          messageId: data.existing_message_id,
          runId: null,
          runStatus: 'duplicate',
          error: 'This email was already ingested'
        });
        return;
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to ingest email');
      }

      // Capture result and start polling if we have a run
      setResult({
        messageId: data.inbound_message_id,
        runId: data.run?.id || null,
        runStatus: data.run?.status || 'no_run'
      });

      // Start polling if we have a run
      if (data.run?.id) {
        setIsPolling(true);
      }

      // Reset form fields but keep dialog open to show status
      setFromEmail("");
      setSubject("");
      setBody("");
      setRawPaste("");
      setShowRawPaste(true);

      onSuccess?.();
    } catch (err: any) {
      console.error('Error ingesting email:', err);
      setError(err.message || 'Failed to ingest email');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setFromEmail("");
    setSubject("");
    setBody("");
    setRawPaste("");
    setShowRawPaste(true);
    setError(null);
    setResult(null);
    setIsPolling(false);
    onOpenChange(false);
  };

  // Helper to render run status with icon
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
        return { icon: <PlayCircle className="h-4 w-4" />, text: 'No run triggered', color: 'text-gray-600' };
      default:
        return { icon: <Clock className="h-4 w-4" />, text: status, color: 'text-gray-600' };
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Paste Inbound Email
          </DialogTitle>
          <DialogDescription>
            Manually add an inbound email from the agency. Paste the full email or fill in the fields below.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Show result after successful ingest */}
        {result && (
          <Alert variant={result.runStatus === 'failed' ? 'destructive' : 'default'} className="bg-muted">
            <AlertTitle className="flex items-center gap-2">
              {(() => {
                const status = getStatusDisplay(result.runStatus);
                return (
                  <>
                    <span className={status.color}>{status.icon}</span>
                    <span>Email Ingested - {status.text}</span>
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
              <div className="font-mono">
                <span className="text-muted-foreground">Status:</span>{' '}
                <span className={getStatusDisplay(result.runStatus).color}>{result.runStatus}</span>
              </div>
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
          {/* Quick paste section */}
          {showRawPaste && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Paste full email</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePasteFromClipboard}
                  className="h-7 text-xs"
                >
                  <ClipboardPaste className="h-3 w-3 mr-1" />
                  Paste from Clipboard
                </Button>
              </div>
              <Textarea
                placeholder="Paste the full email here (From:, Subject:, and body)..."
                value={rawPaste}
                onChange={(e) => handleRawPasteChange(e.target.value)}
                className="min-h-[150px] font-mono text-sm"
              />
              {rawPaste && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setShowRawPaste(false)}
                  className="text-xs px-0"
                >
                  Switch to individual fields
                </Button>
              )}
            </div>
          )}

          {/* Individual fields */}
          {!showRawPaste && (
            <>
              <div className="space-y-2">
                <Label htmlFor="from-email">From Email *</Label>
                <Input
                  id="from-email"
                  type="email"
                  placeholder="foia@agency.gov"
                  value={fromEmail}
                  onChange={(e) => setFromEmail(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="subject">Subject</Label>
                <Input
                  id="subject"
                  placeholder="RE: FOIA Request..."
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="body">Email Body *</Label>
                <Textarea
                  id="body"
                  placeholder="Paste the email body here..."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-[200px]"
                />
              </div>

              <Button
                variant="link"
                size="sm"
                onClick={() => setShowRawPaste(true)}
                className="text-xs px-0"
              >
                Switch to raw paste mode
              </Button>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !body.trim()}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Ingesting...
              </>
            ) : (
              <>
                <Mail className="h-4 w-4 mr-1" />
                Ingest Email
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
