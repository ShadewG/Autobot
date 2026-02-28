"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, X, Send, UserCog, RotateCcw, Settings2 } from "lucide-react";

interface BulkActionBarProps {
  selectedCount: number;
  onDeselectAll: () => void;
  onBulkAction: (action: string) => Promise<{ succeeded: number; failed: number }>;
  selectedIds: Set<string>;
}

export function BulkActionBar({
  selectedCount,
  onDeselectAll,
  onBulkAction,
  selectedIds,
}: BulkActionBarProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<{ succeeded: number; failed: number } | null>(null);

  if (selectedCount === 0) return null;

  const handleAction = async (action: string) => {
    setLoading(action);
    setResult(null);
    try {
      const res = await onBulkAction(action);
      setResult(res);
      if (res.failed === 0) {
        setTimeout(() => {
          onDeselectAll();
          setResult(null);
        }, 2000);
      }
    } catch {
      setResult({ succeeded: 0, failed: selectedCount });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-background border border-border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
      <span className="text-sm font-medium">
        {selectedCount} selected
      </span>

      <div className="h-4 w-px bg-border" />

      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={loading !== null}
        onClick={() => handleAction("follow_up")}
      >
        {loading === "follow_up" ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <Send className="h-3.5 w-3.5 mr-1" />
        )}
        Run Follow-up
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={loading !== null}
        onClick={() => handleAction("take_over")}
      >
        {loading === "take_over" ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <UserCog className="h-3.5 w-3.5 mr-1" />
        )}
        Take Over
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={loading !== null}
        onClick={() => handleAction("requeue")}
      >
        {loading === "requeue" ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5 mr-1" />
        )}
        Requeue
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={loading !== null}
        onClick={() => handleAction("set_manual")}
      >
        {loading === "set_manual" ? (
          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
        ) : (
          <Settings2 className="h-3.5 w-3.5 mr-1" />
        )}
        Set Manual
      </Button>

      <div className="h-4 w-px bg-border" />

      {result && (
        <span className="text-xs text-muted-foreground">
          {result.succeeded} ok{result.failed > 0 ? `, ${result.failed} failed` : ""}
        </span>
      )}

      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onClick={onDeselectAll}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
