"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchAPI } from "@/lib/api";
import { useAuth } from "./auth-provider";
import { Bug, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export function BugReportButton() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Extract case ID from URL if on a case detail page
  const caseIdMatch = pathname.match(/requests\/detail(?:-v2)?/)
    ? new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("id")
    : null;

  const handleSubmit = async () => {
    if (!description.trim()) return;
    setSubmitting(true);
    try {
      await fetchAPI("/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "bug_report",
          title: description.trim().slice(0, 120),
          description: [
            description.trim(),
            "",
            "---",
            `Page: ${pathname}${typeof window !== "undefined" ? window.location.search : ""}`,
            caseIdMatch ? `Case ID: ${caseIdMatch}` : null,
            `User: ${user?.email || "unknown"}`,
            `Time: ${new Date().toISOString()}`,
          ]
            .filter(Boolean)
            .join("\n"),
          priority: "medium",
          case_id: caseIdMatch ? parseInt(caseIdMatch) : null,
        }),
      });
      setSubmitted(true);
      setTimeout(() => {
        setOpen(false);
        setDescription("");
        setSubmitted(false);
      }, 1500);
    } catch {
      toast.error("Failed to submit bug report");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-9 w-9 items-center justify-center rounded-full bg-red-600/80 text-white shadow-lg transition-all hover:bg-red-500 hover:scale-110 hover:opacity-100 active:scale-95 opacity-60"
        title="Report a bug"
      >
        <Bug className="h-4.5 w-4.5" />
      </button>

      {/* Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          {submitted ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="h-8 w-8 text-green-400" />
              <p className="text-sm font-medium">Bug report submitted!</p>
              <p className="text-xs text-muted-foreground">We&apos;ll look into it.</p>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-sm">
                  <Bug className="h-4 w-4 text-red-400" />
                  Report a Bug
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Describe what went wrong. We&apos;ll capture your current page and context automatically.
                </DialogDescription>
              </DialogHeader>

              <Textarea
                placeholder="What happened? What did you expect?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    handleSubmit();
                  }
                }}
              />

              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  Page: <code className="text-foreground/60">{pathname}</code>
                  {caseIdMatch && <span> &middot; Case #{caseIdMatch}</span>}
                </span>
                <span>{user?.email}</span>
              </div>

              <Button
                onClick={handleSubmit}
                disabled={submitting || !description.trim()}
                size="sm"
                className="w-full"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Bug className="h-4 w-4 mr-2" />
                )}
                {submitting ? "Submitting..." : "Submit Report"}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
