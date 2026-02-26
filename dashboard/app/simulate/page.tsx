"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchAPI } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  FlaskConical,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  AlertCircle,
  Mail,
  Brain,
  FileText,
  ClipboardList,
  BookmarkPlus,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SimCase {
  id: number;
  subject_name: string;
  agency_name: string;
  status: string;
  state: string;
}

interface SimClassification {
  messageType: string;
  confidence: number;
  sentiment: string;
  extractedFeeAmount: number | null;
  extractedDeadline: string | null;
  denialSubtype: string | null;
  requiresResponse: boolean;
  portalUrl: string | null;
  suggestedAction: string | null;
  unansweredAgencyQuestion: string | null;
  exemptionCitations: string[];
  evidenceQuotes: string[];
  referralContact: any;
}

interface SimDecision {
  action: string;
  classificationConfidence: number;
  reasoning: string[];
  requiresHuman: boolean;
  canAutoExecute: boolean;
  pauseReason: string | null;
}

interface SimDraftReply {
  to: string;
  subject: string | null;
  body: string | null;
}

interface SimLogEntry {
  step: string;
  result?: string;
  skipped: boolean;
  details?: string;
}

interface SimResult {
  classification: SimClassification;
  decision: SimDecision;
  draftReply: SimDraftReply | null;
  simulationLog: SimLogEntry[];
}

const KNOWN_ACTIONS = [
  "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION", "SEND_APPEAL",
  "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE", "SEND_INITIAL_REQUEST",
  "NEGOTIATE_FEE", "ACCEPT_FEE", "DECLINE_FEE", "RESPOND_PARTIAL_APPROVAL",
  "SUBMIT_PORTAL", "SEND_PDF_EMAIL", "RESEARCH_AGENCY", "REFORMULATE_REQUEST",
  "CLOSE_CASE", "ESCALATE", "NONE", "DISMISSED",
] as const;

// ── Presets ────────────────────────────────────────────────────────────────────

const PRESETS = [
  {
    label: "Fee Quote",
    fromEmail: "records@somecity.gov",
    subject: "RE: Public Records Request - Fee Estimate",
    body: `Thank you for your public records request. We have reviewed your request and determined that the estimated cost to fulfill it is $127.50. This includes 2.5 hours of search time at $45/hour and 75 pages at $0.10/page. Please remit payment within 30 days to proceed. If you would like to proceed, please send a check payable to City of Somecity.`,
  },
  {
    label: "Full Denial",
    fromEmail: "foia@agency.gov",
    subject: "Response to FOIA Request #2024-1234",
    body: `Your request for body camera footage has been denied pursuant to Government Code § 6254(f), which exempts records of complaints to or investigations conducted by law enforcement agencies. The release of this material would endanger the safety of a witness or other person involved in the investigation.`,
  },
  {
    label: "Acknowledgment",
    fromEmail: "records@dept.gov",
    subject: "Acknowledgment of Public Records Request",
    body: `We have received your public records request dated January 15, 2025. Your request has been assigned reference number PRR-2025-4421. We will respond within 10 business days as required by the California Public Records Act. If we require additional time, we will notify you in advance.`,
  },
  {
    label: "Partial Approval",
    fromEmail: "openrecords@city.gov",
    subject: "Response to Your Records Request",
    body: `We are pleased to provide the attached documents in response to your request. Please note that certain portions have been redacted under the deliberative process privilege (5 U.S.C. § 552(b)(5)). The incident report is attached in full. Body camera footage is available but a separate fee of $25 applies for the digital media. Please let us know if you would like to proceed.`,
  },
  {
    label: "Referral",
    fromEmail: "records@statepd.gov",
    subject: "RE: Public Records Request Referral",
    body: `Your records request has been referred to the Department of Justice Records Management Division as the records you are seeking are maintained by that agency. Please contact them directly at doj.records@doj.gov or (916) 555-0100. We have forwarded a copy of your request on your behalf.`,
  },
];

// ── Helper Components ──────────────────────────────────────────────────────────

function CollapsibleCard({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
  badge,
}: {
  title: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <CardHeader
        className="py-3 px-4 cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <CardTitle className="text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
            {badge}
          </div>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </CardTitle>
      </CardHeader>
      {open && <CardContent className="pt-0 pb-4 px-4">{children}</CardContent>}
    </Card>
  );
}

function ActionBadge({ action }: { action: string }) {
  const color =
    action.startsWith("SEND_") || action.startsWith("RESPOND_") || action.startsWith("ACCEPT_") || action.startsWith("NEGOTIATE_") || action.startsWith("DECLINE_") || action.startsWith("REFORMULATE_")
      ? "text-blue-400 bg-blue-500/10"
      : action === "CLOSE_CASE"
      ? "text-red-400 bg-red-500/10"
      : action === "AWAIT_RESPONSE" || action === "NO_ACTION"
      ? "text-muted-foreground bg-muted/50"
      : action === "NEEDS_HUMAN_REVIEW" || action === "ESCALATE_TO_HUMAN"
      ? "text-amber-400 bg-amber-500/10"
      : "text-foreground bg-muted/50";
  return (
    <Badge variant="outline" className={cn("font-mono text-xs", color)}>
      {action}
    </Badge>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "bg-green-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-9 text-right">{pct}%</span>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function SimulatePage() {
  const [messageBody, setMessageBody] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [caseId, setCaseId] = useState<string>("");
  const [cases, setCases] = useState<SimCase[]>([]);
  const [casesLoaded, setCasesLoaded] = useState(false);

  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<SimResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Save as eval state
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalExpected, setEvalExpected] = useState("");
  const [evalNotes, setEvalNotes] = useState("");
  const [evalSaving, setEvalSaving] = useState(false);
  const [evalSaved, setEvalSaved] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any in-flight poll timer on unmount
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const loadCases = useCallback(async () => {
    if (casesLoaded) return;
    try {
      const data = await fetchAPI<{ success: boolean; cases: SimCase[] }>("/simulate/cases");
      setCases(data.cases || []);
      setCasesLoaded(true);
    } catch {
      // non-fatal
    }
  }, [casesLoaded]);

  const applyPreset = (preset: (typeof PRESETS)[0]) => {
    setFromEmail(preset.fromEmail);
    setSubject(preset.subject);
    setMessageBody(preset.body);
    setResult(null);
    setErrorMsg(null);
    setStatus("idle");
  };

  const pollRun = useCallback(async (runId: string) => {
    try {
      const data = await fetchAPI<{
        success: boolean;
        status: string;
        output?: SimResult;
        error?: string;
      }>(`/simulate/${runId}`);

      if (data.status === "COMPLETED" && data.output) {
        setResult(data.output);
        setStatus("done");
        return;
      }
      if (data.status === "FAILED" || data.status === "CRASHED" || data.status === "CANCELED") {
        setErrorMsg(data.error || `Simulation ${data.status.toLowerCase()}`);
        setStatus("error");
        return;
      }
      // Still running — poll again in 2s
      pollRef.current = setTimeout(() => pollRun(runId), 2000);
    } catch (e: any) {
      setErrorMsg(e.message || "Polling error");
      setStatus("error");
    }
  }, []);

  const handleSimulate = async () => {
    if (!messageBody.trim() || !fromEmail.trim() || !subject.trim()) return;

    if (pollRef.current) clearTimeout(pollRef.current);
    setStatus("running");
    setResult(null);
    setErrorMsg(null);
    setEvalOpen(false);
    setEvalSaved(false);
    setEvalExpected("");
    setEvalNotes("");
    setEvalError(null);

    try {
      const data = await fetchAPI<{ success: boolean; runId: string; error?: string }>(
        "/simulate",
        {
          method: "POST",
          body: JSON.stringify({
            messageBody: messageBody.trim(),
            fromEmail: fromEmail.trim(),
            subject: subject.trim(),
            caseId: caseId || undefined,
          }),
        }
      );

      if (!data.success || !data.runId) {
        throw new Error(data.error || "Failed to start simulation");
      }

      pollRef.current = setTimeout(() => pollRun(data.runId), 2000);
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to start simulation");
      setStatus("error");
    }
  };

  const canSimulate =
    messageBody.trim().length >= 10 && fromEmail.trim() && subject.trim() && status !== "running";

  const handleSaveEval = async () => {
    if (!result || !evalExpected) return;
    setEvalSaving(true);
    try {
      await fetchAPI("/eval/cases/from-simulation", {
        method: "POST",
        body: JSON.stringify({
          expectedAction: evalExpected,
          notes: evalNotes || undefined,
          predictedAction: result.decision.action,
          reasoning: result.decision.reasoning,
          draftBody: result.draftReply?.body || undefined,
          messageBody: messageBody.trim(),
          fromEmail: fromEmail.trim(),
          subject: subject.trim(),
          caseId: caseId || undefined,
        }),
      });
      setEvalSaved(true);
      setEvalOpen(false);
    } catch (e: any) {
      setEvalError(e.message || "Failed to save");
    } finally {
      setEvalSaving(false);
    }
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-9rem)] min-h-0">
      {/* ── Left Panel: Input ─────────────────────────────────────────────── */}
      <div className="w-[420px] shrink-0 flex flex-col gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FlaskConical className="h-5 w-5" />
            Decision Simulator
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dry-run the full AI pipeline — no emails sent, no DB writes.
          </p>
        </div>

        {/* Presets */}
        <div>
          <p className="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">Presets</p>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                className="text-xs px-2.5 py-1 rounded border border-border bg-muted/30 hover:bg-muted transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* From Email */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">From Email</label>
          <input
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="records@agency.gov"
            className="w-full text-sm bg-background border border-border rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          />
        </div>

        {/* Subject */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Subject</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="RE: Public Records Request"
            className="w-full text-sm bg-background border border-border rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          />
        </div>

        {/* Case Context */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Case Context{" "}
            <span className="text-muted-foreground/60">(optional — loads real case history)</span>
          </label>
          <select
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            onFocus={loadCases}
            className="w-full text-sm bg-background border border-border rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring text-muted-foreground"
          >
            <option value="">No case (mock context)</option>
            {cases.map((c) => (
              <option key={c.id} value={String(c.id)}>
                #{c.id} — {c.subject_name || c.agency_name} ({c.state})
              </option>
            ))}
          </select>
        </div>

        {/* Message Body */}
        <div className="flex-1 flex flex-col min-h-0">
          <label className="text-xs text-muted-foreground mb-1 block">Message Body</label>
          <textarea
            value={messageBody}
            onChange={(e) => setMessageBody(e.target.value)}
            placeholder="Paste the agency email body here..."
            className="flex-1 min-h-[160px] text-sm bg-background border border-border rounded px-3 py-2 outline-none focus:ring-1 focus:ring-ring resize-none placeholder:text-muted-foreground/50 font-mono"
          />
        </div>

        <Button
          onClick={handleSimulate}
          disabled={!canSimulate}
          className="w-full"
        >
          {status === "running" ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Simulating…
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-2" />
              Run Simulation
            </>
          )}
        </Button>
      </div>

      {/* ── Right Panel: Output ───────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <ScrollArea className="flex-1 pr-1">
          {status === "idle" && (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
              <FlaskConical className="h-10 w-10 opacity-20" />
              <p className="text-sm">Select a preset or paste a message, then run the simulation.</p>
            </div>
          )}

          {status === "running" && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Running pipeline… classify → decide → draft</p>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-destructive">
              <AlertCircle className="h-8 w-8" />
              <p className="text-sm font-medium">Simulation failed</p>
              {errorMsg && <p className="text-xs text-muted-foreground">{errorMsg}</p>}
            </div>
          )}

          {status === "done" && result && (
            <div className="space-y-3 pb-4">
              {/* ── Save as Eval ── */}
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-muted-foreground">
                  AI decided: <ActionBadge action={result.decision.action} />
                </span>
                {evalSaved ? (
                  <Badge variant="outline" className="text-green-400 bg-green-500/10 gap-1 text-xs">
                    <CheckCircle className="h-3 w-3" /> Saved to Evals
                  </Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => setEvalOpen((o) => !o)}
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    Save as Eval
                  </Button>
                )}
              </div>

              {evalOpen && !evalSaved && (
                <Card className="border-amber-500/30 bg-amber-500/5">
                  <CardContent className="pt-4 pb-4 px-4 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      The AI chose <span className="font-mono text-foreground">{result.decision.action}</span>.
                      What should it have done?
                    </p>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Correct Action</label>
                      <select
                        value={evalExpected}
                        onChange={(e) => setEvalExpected(e.target.value)}
                        className="w-full text-sm bg-background border border-border rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="">Select the correct action…</option>
                        {KNOWN_ACTIONS.map((a) => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</label>
                      <textarea
                        value={evalNotes}
                        onChange={(e) => setEvalNotes(e.target.value)}
                        placeholder="Why was this the correct action? Any context..."
                        rows={2}
                        className="w-full text-sm bg-background border border-border rounded px-3 py-1.5 outline-none focus:ring-1 focus:ring-ring resize-none placeholder:text-muted-foreground/50"
                      />
                    </div>
                    {evalError && (
                      <p className="text-xs text-destructive">{evalError}</p>
                    )}
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEvalOpen(false); setEvalError(null); }}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!evalExpected || evalSaving}
                        onClick={handleSaveEval}
                      >
                        {evalSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                        Save
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* ── Decision Card ── */}
              <CollapsibleCard
                title="Decision"
                icon={Brain}
                badge={
                  <ActionBadge action={result.decision.action} />
                }
              >
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Action</p>
                      <ActionBadge action={result.decision.action} />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Human Required</p>
                      {result.decision.requiresHuman ? (
                        <Badge variant="outline" className="text-amber-400 bg-amber-500/10 gap-1 text-xs">
                          <AlertCircle className="h-3 w-3" /> Yes
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-green-400 bg-green-500/10 gap-1 text-xs">
                          <CheckCircle className="h-3 w-3" /> No
                        </Badge>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Can Auto-Execute</p>
                      {result.decision.canAutoExecute ? (
                        <Badge variant="outline" className="text-green-400 bg-green-500/10 text-xs">Yes</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground text-xs">No</Badge>
                      )}
                    </div>
                    {result.decision.pauseReason && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Pause Reason</p>
                        <span className="text-xs font-mono">{result.decision.pauseReason}</span>
                      </div>
                    )}
                  </div>

                  {result.decision.reasoning.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">Reasoning</p>
                      <ul className="space-y-1">
                        {result.decision.reasoning.map((r, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs">
                            <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </CollapsibleCard>

              {/* ── Classification Card ── */}
              <CollapsibleCard
                title="Classification"
                icon={Mail}
                badge={
                  <Badge variant="secondary" className="font-mono text-xs">
                    {result.classification.messageType}
                  </Badge>
                }
              >
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Message Type</p>
                      <span className="text-xs font-mono">{result.classification.messageType}</span>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Sentiment</p>
                      <span className="text-xs font-mono capitalize">{result.classification.sentiment}</span>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Requires Response</p>
                      {result.classification.requiresResponse ? (
                        <Badge variant="outline" className="text-blue-400 bg-blue-500/10 text-xs">Yes</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground text-xs">No</Badge>
                      )}
                    </div>
                    {result.classification.extractedFeeAmount != null && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Fee Amount</p>
                        <span className="text-xs font-mono text-amber-400">
                          ${result.classification.extractedFeeAmount.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {result.classification.extractedDeadline && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Deadline</p>
                        <span className="text-xs font-mono">{result.classification.extractedDeadline}</span>
                      </div>
                    )}
                    {result.classification.denialSubtype && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Denial Subtype</p>
                        <span className="text-xs font-mono">{result.classification.denialSubtype}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Confidence</p>
                    <ConfidenceMeter value={result.classification.confidence} />
                  </div>

                  {result.classification.exemptionCitations.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Exemption Citations</p>
                      <div className="flex flex-wrap gap-1">
                        {result.classification.exemptionCitations.map((c, i) => (
                          <Badge key={i} variant="outline" className="text-xs font-mono text-red-400 bg-red-500/10">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.classification.evidenceQuotes.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Evidence Quotes</p>
                      <div className="space-y-1">
                        {result.classification.evidenceQuotes.map((q, i) => (
                          <blockquote
                            key={i}
                            className="text-xs italic border-l-2 border-muted pl-2 text-muted-foreground"
                          >
                            "{q}"
                          </blockquote>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.classification.unansweredAgencyQuestion && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Unanswered Agency Question</p>
                      <p className="text-xs italic">{result.classification.unansweredAgencyQuestion}</p>
                    </div>
                  )}

                  {result.classification.suggestedAction && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Suggested Action</p>
                      <span className="text-xs font-mono">{result.classification.suggestedAction}</span>
                    </div>
                  )}
                </div>
              </CollapsibleCard>

              {/* ── Draft Reply Card ── */}
              {result.draftReply && (
                <CollapsibleCard
                  title="Draft Reply"
                  icon={FileText}
                  badge={
                    <Badge variant="outline" className="text-green-400 bg-green-500/10 text-xs">Generated</Badge>
                  }
                >
                  <div className="space-y-2">
                    <div className="text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <span className="text-muted-foreground">To:</span>
                      <span className="font-mono">{result.draftReply.to}</span>
                      {result.draftReply.subject && (
                        <>
                          <span className="text-muted-foreground">Subject:</span>
                          <span>{result.draftReply.subject}</span>
                        </>
                      )}
                    </div>
                    {result.draftReply.body && (
                      <div className="mt-2 p-3 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap leading-relaxed border border-border/50 max-h-64 overflow-y-auto">
                        {result.draftReply.body}
                      </div>
                    )}
                  </div>
                </CollapsibleCard>
              )}

              {/* ── Simulation Trace Card ── */}
              <CollapsibleCard
                title="Simulation Trace"
                icon={ClipboardList}
                defaultOpen={false}
              >
                <div className="space-y-1">
                  {result.simulationLog.map((entry, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-start gap-2 text-xs py-1 px-2 rounded",
                        entry.skipped ? "opacity-50" : ""
                      )}
                    >
                      {entry.skipped ? (
                        <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <CheckCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-400" />
                      )}
                      <div className="min-w-0">
                        <span className="font-mono text-muted-foreground">{entry.step}</span>
                        {entry.result && (
                          <span className="text-foreground ml-2">{entry.result}</span>
                        )}
                        {entry.details && (
                          <span className="text-muted-foreground ml-2 italic">{entry.details}</span>
                        )}
                        {entry.skipped && (
                          <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 text-muted-foreground">
                            SKIPPED
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsibleCard>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
