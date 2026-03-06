"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { casesAPI } from "@/lib/api";
import { Plus, Loader2, ExternalLink, CheckCircle, AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";

interface NotionImportProps {
  onImported?: (caseId: number) => void;
}

interface BulkImportItemResult {
  notionUrl: string;
  success: boolean;
  message: string;
  caseId?: number;
  caseName?: string;
  autoSendStatus?: "pending" | "success" | "error";
  autoSendMessage?: string;
  autoSendError?: string;
}

export function NotionImport({ onImported }: NotionImportProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notionUrl, setNotionUrl] = useState("");
  const [autoSend, setAutoSend] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isAutoSending, setIsAutoSending] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ total: number; processed: number } | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkImportItemResult[] | null>(null);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    caseId?: number;
    caseName?: string;
    autoSendStatus?: "pending" | "success" | "error";
    autoSendMessage?: string;
    autoSendError?: string;
  } | null>(null);

  const parseNotionInputs = (input: string): string[] => {
    const parsed = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return Array.from(new Set(parsed));
  };

  const runSingleImport = async (url: string): Promise<BulkImportItemResult> => {
    const response = await casesAPI.createFromNotion(url);
    const item: BulkImportItemResult = {
      notionUrl: url,
      success: Boolean(response.success),
      message: response.message || "Imported",
      caseId: response.case_id,
      caseName: (response as any).case?.case_name || (response.case_id ? `Case #${response.case_id}` : undefined),
      autoSendStatus: autoSend ? "pending" : undefined,
    };

    if (response.success && response.case_id) {
      onImported?.(response.case_id);
      if (autoSend) {
        try {
          const runResponse = await casesAPI.runInitial(response.case_id, { autopilotMode: "AUTO" });
          item.autoSendStatus = "success";
          item.autoSendMessage = runResponse.message || "Initial request queued to send";
        } catch (error: any) {
          item.autoSendStatus = "error";
          item.autoSendError = error?.message || "Failed to start initial send";
        }
      }
    }

    return item;
  };

  const handleImport = async () => {
    const inputs = parseNotionInputs(notionUrl);
    if (inputs.length === 0) return;

    setIsImporting(true);
    setIsAutoSending(false);
    setResult(null);
    setBulkResults(null);
    setBulkProgress(null);

    try {
      if (inputs.length === 1) {
        const single = await runSingleImport(inputs[0]);
        setResult({
          success: single.success,
          message: single.message,
          caseId: single.caseId,
          caseName: single.caseName,
          autoSendStatus: single.autoSendStatus,
          autoSendMessage: single.autoSendMessage,
          autoSendError: single.autoSendError,
        });
        return;
      }

      const concurrency = 3;
      const queue = [...inputs];
      const collected: BulkImportItemResult[] = [];
      let processed = 0;
      setBulkProgress({ total: inputs.length, processed: 0 });
      setIsAutoSending(autoSend);

      const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) return;
          try {
            const item = await runSingleImport(current);
            collected.push(item);
          } catch (error: any) {
            collected.push({
              notionUrl: current,
              success: false,
              message: error?.message || "Import failed",
            });
          }
          processed += 1;
          setBulkProgress({ total: inputs.length, processed });
        }
      });

      await Promise.all(workers);
      const sorted = inputs.map((input) => collected.find((row) => row.notionUrl === input)).filter(Boolean) as BulkImportItemResult[];
      setBulkResults(sorted);
      const successCount = sorted.filter((row) => row.success).length;
      const failedCount = sorted.length - successCount;
      setResult({
        success: failedCount === 0,
        message: `Processed ${sorted.length} cases: ${successCount} succeeded, ${failedCount} failed.`,
      });
    } catch (error: any) {
      setResult({
        success: false,
        message: error.message || "Failed to import from Notion",
      });
    } finally {
      setIsImporting(false);
      setIsAutoSending(false);
    }
  };

  const firstSuccessfulBulkCaseId = bulkResults?.find((row) => row.caseId)?.caseId;

  const handleViewCase = () => {
    const caseId = result?.caseId || firstSuccessfulBulkCaseId;
    if (caseId) {
      setOpen(false);
      router.push(`/requests/detail-v2?id=${caseId}`);
    }
  };

  const handleReset = () => {
    setNotionUrl("");
    setAutoSend(true);
    setResult(null);
    setBulkProgress(null);
    setBulkResults(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          Import from Notion
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import Case(s) from Notion</DialogTitle>
          <DialogDescription>
            Paste one or multiple Notion page URLs (one per line) to import in bulk safely.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="py-4">
            {result.success ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-700/50 rounded-lg">
                  <CheckCircle className="h-5 w-5 text-green-400 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-green-300">{result.message}</p>
                    {result.caseName && (
                      <p className="text-sm text-green-300">{result.caseName}</p>
                    )}
                    {result.autoSendStatus === "pending" && (
                      <p className="text-xs text-amber-300 mt-1">
                        Queuing generation + send in AUTO mode...
                      </p>
                    )}
                    {result.autoSendStatus === "success" && result.autoSendMessage && (
                      <p className="text-xs text-green-300 mt-1">{result.autoSendMessage}</p>
                    )}
                    {result.autoSendStatus === "error" && result.autoSendError && (
                      <p className="text-xs text-red-300 mt-1">{result.autoSendError}</p>
                    )}
                    {bulkResults && bulkResults.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Bulk import complete.
                      </p>
                    )}
                  </div>
                </div>
                {bulkResults && bulkResults.length > 0 && (
                  <div className="max-h-56 overflow-auto rounded border p-2 space-y-1">
                    {bulkResults.map((row, idx) => (
                      <div key={`${row.notionUrl}-${idx}`} className="text-xs">
                        <span className={row.success ? "text-green-400" : "text-red-400"}>
                          {row.success ? "✓" : "✗"}
                        </span>{" "}
                        <span className="truncate">{row.notionUrl}</span>
                        {row.caseId ? <span className="text-muted-foreground"> · #{row.caseId}</span> : null}
                        {row.autoSendStatus === "error" && row.autoSendError ? (
                          <span className="text-red-300"> · send: {row.autoSendError}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Button onClick={handleViewCase} className="flex-1 gap-1" disabled={!result.caseId && !firstSuccessfulBulkCaseId}>
                    <ExternalLink className="h-4 w-4" />
                    View Case
                  </Button>
                  <Button variant="outline" onClick={handleReset}>
                    Import Another
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-700/50 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-red-300">Import Failed</p>
                    <p className="text-sm text-red-300">{result.message}</p>
                  </div>
                </div>
                <Button variant="outline" onClick={handleReset} className="w-full">
                  Try Again
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="notion-url">
                  Notion Page URL(s)
                </label>
                <Textarea
                  id="notion-url"
                  placeholder={"https://www.notion.so/workspace/Case-Name-abc123...\nhttps://www.notion.so/workspace/Another-Case-def456..."}
                  value={notionUrl}
                  onChange={(e) => setNotionUrl(e.target.value)}
                  rows={6}
                />
                <p className="text-xs text-muted-foreground">
                  One URL per line. Bulk import runs with controlled concurrency to avoid queue spikes.
                </p>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="text-sm">Auto-send after import</Label>
                  <p className="text-xs text-muted-foreground">
                    Imports, then queues generation + send in AUTO mode per case.
                  </p>
                </div>
                <Switch
                  id="auto-send"
                  checked={autoSend}
                  onCheckedChange={(checked) => setAutoSend(!!checked)}
                />
              </div>
              {bulkProgress && (
                <p className="text-xs text-muted-foreground">
                  Processing {bulkProgress.processed}/{bulkProgress.total}...
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={!notionUrl.trim() || isImporting || isAutoSending}
              >
                {isImporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  "Import Case(s)"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
