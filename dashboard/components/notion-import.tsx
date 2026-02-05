"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export function NotionImport({ onImported }: NotionImportProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notionUrl, setNotionUrl] = useState("");
  const [autoSend, setAutoSend] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isAutoSending, setIsAutoSending] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
    caseId?: number;
    caseName?: string;
    autoSendStatus?: "pending" | "success" | "error";
    autoSendMessage?: string;
    autoSendError?: string;
  } | null>(null);

  const handleImport = async () => {
    if (!notionUrl.trim()) return;

    setIsImporting(true);
    setResult(null);

    try {
      const response = await casesAPI.createFromNotion(notionUrl.trim());

      if (response.success) {
        setResult({
          success: true,
          message: response.message,
          caseId: response.case_id,
          caseName: (response as any).case?.case_name || `Case #${response.case_id}`,
          autoSendStatus: autoSend ? "pending" : undefined,
        });

        onImported?.(response.case_id);

        if (autoSend) {
          setIsAutoSending(true);
          try {
            const runResponse = await casesAPI.runInitial(response.case_id, {
              autopilotMode: "AUTO",
            });

            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    autoSendStatus: "success",
                    autoSendMessage:
                      runResponse.message || "Initial request queued to send",
                  }
                : prev
            );
          } catch (error: any) {
            setResult((prev) =>
              prev
                ? {
                    ...prev,
                    autoSendStatus: "error",
                    autoSendError: error?.message || "Failed to start initial send",
                  }
                : prev
            );
          } finally {
            setIsAutoSending(false);
          }
        }
      } else {
        setResult({
          success: false,
          message: (response as any).error || "Import failed",
        });
      }
    } catch (error: any) {
      setResult({
        success: false,
        message: error.message || "Failed to import from Notion",
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleViewCase = () => {
    if (result?.caseId) {
      setOpen(false);
      router.push(`/requests/detail?id=${result.caseId}`);
    }
  };

  const handleReset = () => {
    setNotionUrl("");
    setAutoSend(true);
    setResult(null);
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
          <DialogTitle>Import Case from Notion</DialogTitle>
          <DialogDescription>
            Paste a Notion page URL to import case details automatically.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="py-4">
            {result.success ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-green-800">{result.message}</p>
                    {result.caseName && (
                      <p className="text-sm text-green-700">{result.caseName}</p>
                    )}
                    {result.autoSendStatus === "pending" && (
                      <p className="text-xs text-amber-700 mt-1">
                        Queuing generation + send in AUTO mode...
                      </p>
                    )}
                    {result.autoSendStatus === "success" && result.autoSendMessage && (
                      <p className="text-xs text-green-700 mt-1">{result.autoSendMessage}</p>
                    )}
                    {result.autoSendStatus === "error" && result.autoSendError && (
                      <p className="text-xs text-red-700 mt-1">{result.autoSendError}</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={handleViewCase} className="flex-1 gap-1">
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
                <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-red-800">Import Failed</p>
                    <p className="text-sm text-red-700">{result.message}</p>
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
                  Notion Page URL
                </label>
                <Input
                  id="notion-url"
                  placeholder="https://www.notion.so/workspace/Case-Name-abc123..."
                  value={notionUrl}
                  onChange={(e) => setNotionUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && notionUrl.trim()) {
                      handleImport();
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  The Notion integration must have access to this page.
                </p>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="text-sm">Auto-send after import</Label>
                  <p className="text-xs text-muted-foreground">
                    Imports, then immediately queues generation + send in AUTO mode.
                  </p>
                </div>
                <Switch
                  id="auto-send"
                  checked={autoSend}
                  onCheckedChange={(checked) => setAutoSend(!!checked)}
                />
              </div>
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
                  "Import Case"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
