"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetcher, fetchAPI } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  FlaskConical,
  Play,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader2,
  Minus,
  TrendingUp,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";

interface EvalCase {
  id: number;
  proposal_id: number;
  case_id: number;
  expected_action: string;
  notes: string | null;
  created_at: string;
  case_name: string;
  agency_name: string;
  proposal_action: string;
  last_run_id: number | null;
  last_predicted_action: string | null;
  last_action_correct: boolean | null;
  last_judge_score: number | null;
  last_failure_category: string | null;
  last_ran_at: string | null;
}

interface EvalSummary {
  total_cases: number;
  runs_last_7d: number;
  avg_score_7d: number | null;
  pass_rate_7d: number | null;
}

interface FailureBreakdownItem {
  failure_category: string;
  count: number;
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span className="text-muted-foreground text-xs">—</span>;
  const color =
    score >= 4
      ? "text-green-400 bg-green-500/10"
      : score >= 3
      ? "text-amber-400 bg-amber-500/10"
      : "text-red-400 bg-red-500/10";
  return (
    <Badge variant="outline" className={cn("font-mono", color)}>
      {score}/5
    </Badge>
  );
}

function PassBadge({ correct }: { correct: boolean | null }) {
  if (correct === null) return <span className="text-muted-foreground text-xs">—</span>;
  if (correct)
    return (
      <Badge variant="outline" className="text-green-400 bg-green-500/10 gap-1">
        <CheckCircle className="h-3 w-3" /> Pass
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-red-400 bg-red-500/10 gap-1">
      <XCircle className="h-3 w-3" /> Fail
    </Badge>
  );
}

const TRIGGER_PROJECT_URL = "https://cloud.trigger.dev/projects/v3/proj_afwkrlynxcczbgflspqf";

export default function EvalPage() {
  const [runningAll, setRunningAll] = useState(false);
  const [runningId, setRunningId] = useState<number | null>(null);
  const [selectedCase, setSelectedCase] = useState<EvalCase | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [lastTriggerRunId, setLastTriggerRunId] = useState<string | null>(null);

  const { data: casesData, mutate: mutateCases, isLoading: casesLoading } = useSWR<{
    success: boolean;
    cases: EvalCase[];
  }>("/eval/cases", fetcher, { refreshInterval: 15000 });

  const { data: summaryData, mutate: mutateSummary } = useSWR<{
    success: boolean;
    summary: EvalSummary;
    failure_breakdown: FailureBreakdownItem[];
  }>("/eval/summary", fetcher, { refreshInterval: 30000 });

  const evalCases = casesData?.cases || [];
  const summary = summaryData?.summary;
  const failureBreakdown = summaryData?.failure_breakdown || [];

  const handleRunAll = async () => {
    setRunningAll(true);
    try {
      const result = await fetchAPI<{ success: boolean; trigger_run_id: string }>("/eval/run", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (result.success) {
        setLastTriggerRunId(result.trigger_run_id);
        setTimeout(() => {
          mutateCases();
          mutateSummary();
        }, 3000);
      }
    } catch (e) {
      console.error("Failed to run evals:", e);
    } finally {
      setRunningAll(false);
    }
  };

  const handleRunSingle = async (evalCaseId: number) => {
    setRunningId(evalCaseId);
    try {
      const result = await fetchAPI<{ success: boolean; trigger_run_id: string }>("/eval/run", {
        method: "POST",
        body: JSON.stringify({ evalCaseId }),
      });
      if (result.success) {
        setLastTriggerRunId(result.trigger_run_id);
        setTimeout(() => {
          mutateCases();
          mutateSummary();
        }, 5000);
      }
    } catch (e) {
      console.error("Failed to run eval:", e);
    } finally {
      setRunningId(null);
    }
  };

  const handleViewHistory = async (evalCase: EvalCase) => {
    setSelectedCase(evalCase);
    setLoadingHistory(true);
    setHistory([]);
    try {
      const result = await fetchAPI<{ success: boolean; runs: any[] }>(
        `/eval/cases/${evalCase.id}/history`
      );
      setHistory(result.runs || []);
    } catch (e) {
      console.error("Failed to load history:", e);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleRemove = async (id: number) => {
    try {
      await fetchAPI(`/eval/cases/${id}`, { method: "DELETE" });
      mutateCases();
    } catch (e) {
      console.error("Failed to remove eval case:", e);
    }
  };

  const passRate = summary?.pass_rate_7d;
  const passRateDisplay =
    passRate != null ? `${Math.round(passRate * 100)}%` : "—";
  const avgScore = summary?.avg_score_7d;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FlaskConical className="h-6 w-6" />
            AI Decision Evals
          </h1>
          <p className="text-sm text-muted-foreground">
            Ground-truth dataset of human-verified decisions. Score AI quality with LLM-as-judge.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastTriggerRunId && (
            <a
              href={`${TRIGGER_PROJECT_URL}/runs/${lastTriggerRunId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              View last run →
            </a>
          )}
          <Button variant="outline" size="sm" onClick={() => { mutateCases(); mutateSummary(); }}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleRunAll}
            disabled={runningAll || evalCases.length === 0}
          >
            {runningAll ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-1" />
            )}
            Run All Evals
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Eval Cases</p>
            <p className="text-2xl font-bold">{summary?.total_cases ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Pass Rate (7d)</p>
            <p
              className={cn(
                "text-2xl font-bold",
                passRate != null
                  ? passRate >= 0.8
                    ? "text-green-400"
                    : passRate >= 0.6
                    ? "text-amber-400"
                    : "text-red-400"
                  : ""
              )}
            >
              {passRateDisplay}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Avg Score (7d)</p>
            <p className="text-2xl font-bold">
              {avgScore != null ? `${avgScore.toFixed(1)}/5` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Runs (7d)</p>
            <p className="text-2xl font-bold">{summary?.runs_last_7d ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Eval Cases Table */}
        <div className="col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Eval Cases
              </CardTitle>
            </CardHeader>
            <CardContent>
              {casesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : evalCases.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FlaskConical className="h-8 w-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No eval cases yet.</p>
                  <p className="text-xs mt-1">
                    In any proposal queue card, click "Mark as Eval Case" to add it here.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Case</TableHead>
                      <TableHead>Expected</TableHead>
                      <TableHead>AI Predicted</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead className="w-[80px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {evalCases.map((ec) => (
                      <TableRow key={ec.id} className="cursor-pointer hover:bg-muted/50">
                        <TableCell>
                          <Link
                            href={`/requests/detail?id=${ec.case_id}`}
                            className="hover:underline text-primary text-sm"
                          >
                            {ec.case_name || ec.agency_name || `Case ${ec.case_id}`}
                          </Link>
                          {ec.notes && (
                            <p className="text-xs text-muted-foreground truncate max-w-[160px]">
                              {ec.notes}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-xs font-mono">
                            {ec.expected_action}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {ec.last_predicted_action ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-xs font-mono",
                                ec.last_action_correct
                                  ? "text-green-400"
                                  : "text-red-400"
                              )}
                            >
                              {ec.last_predicted_action}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">Not run</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <PassBadge correct={ec.last_action_correct} />
                        </TableCell>
                        <TableCell>
                          <ScoreBadge score={ec.last_judge_score} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={runningId === ec.id}
                              onClick={() => handleRunSingle(ec.id)}
                              title="Run eval"
                            >
                              {runningId === ec.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewHistory(ec)}
                              title="View history"
                            >
                              <ChevronRight className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Failure Breakdown */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Failure Categories
                <span className="text-xs text-muted-foreground font-normal ml-1">(30d)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {failureBreakdown.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="h-6 w-6 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">No failures recorded</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {failureBreakdown.map((item) => (
                    <div key={item.failure_category} className="flex items-center justify-between">
                      <span className="text-xs font-mono text-muted-foreground">
                        {item.failure_category}
                      </span>
                      <Badge variant="outline" className="text-xs text-red-400 bg-red-500/10">
                        {item.count}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">How to add eval cases</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2">
              <p>
                1. Open any case in the queue or requests view.
              </p>
              <p>
                2. On the proposal card, click the{" "}
                <span className="font-medium text-foreground">⋮ menu → Mark as Eval Case</span>.
              </p>
              <p>
                3. Set the expected correct action and optional notes.
              </p>
              <p>
                4. Come back here and click{" "}
                <span className="font-medium text-foreground">Run All Evals</span>{" "}
                to score all cases with LLM-as-judge.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* History Dialog */}
      <Dialog open={!!selectedCase} onOpenChange={(open) => !open && setSelectedCase(null)}>
        <DialogContent className="max-w-2xl max-h-[70vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" />
              Eval History — {selectedCase?.case_name || `Case ${selectedCase?.case_id}`}
            </DialogTitle>
          </DialogHeader>
          {loadingHistory ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ScrollArea className="h-[400px]">
              {history.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground text-sm">
                  No eval runs yet for this case.
                </p>
              ) : (
                <div className="space-y-3 p-1">
                  {history.map((run) => (
                    <div
                      key={run.id}
                      className="border rounded-md p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <PassBadge correct={run.action_correct} />
                          <ScoreBadge score={run.judge_score} />
                          {run.failure_category && (
                            <Badge variant="outline" className="text-xs text-red-400 bg-red-500/10">
                              {run.failure_category}
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(run.ran_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Predicted:</span>
                        <Badge variant="secondary" className="font-mono text-xs">
                          {run.predicted_action || "—"}
                        </Badge>
                      </div>
                      {run.judge_reasoning && (
                        <p className="text-xs text-muted-foreground border-t pt-2">
                          {run.judge_reasoning}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
