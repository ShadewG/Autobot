"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";

const CHANGELOG_VERSION_KEY = "autobot_last_seen_changelog";

// Bump this version whenever you deploy notable changes.
// The popup shows once per user per version.
const CURRENT_VERSION = "0.9.2";
export const CURRENT_CHANGELOG_VERSION = CURRENT_VERSION;

interface ChangeEntry {
  category: "feature" | "fix" | "improvement";
  title: string;
  description: string;
}

const entries: ChangeEntry[] = [
  {
    category: "feature",
    title: "Bug reporting from any page",
    description:
      "Click the bug icon in the bottom-right corner to report issues instantly. It captures your current page and context automatically.",
  },
  {
    category: "feature",
    title: "Feature requests",
    description:
      "Go to Feedback in the nav to submit feature ideas or browse past requests.",
  },
  {
    category: "feature",
    title: "Mark cases as bugged",
    description:
      'Open the \u22EF menu on any case and select "Mark as Bugged" to flag it for investigation.',
  },
  {
    category: "improvement",
    title: "System health drill-down",
    description:
      "Click any system health metric to see the actual cases and errors behind the number.",
  },
  {
    category: "feature",
    title: "Batch case creation",
    description:
      "Send the same FOIA request to multiple agencies at once from the Cases page.",
  },
  {
    category: "feature",
    title: "Email attachments",
    description:
      "Attach files to outbound FOIA emails from the proposal approval screen.",
  },
  {
    category: "improvement",
    title: "Error tracking & audit trail",
    description:
      "All system errors captured with full context. Activity log tracks who did what.",
  },
];

const categoryStyles: Record<string, { label: string; className: string }> = {
  feature: {
    label: "New",
    className: "bg-green-500/20 text-green-400 border-green-500/30",
  },
  fix: {
    label: "Fix",
    className: "bg-red-500/20 text-red-400 border-red-500/30",
  },
  improvement: {
    label: "Improved",
    className: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  },
};

export function ChangelogPopup() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const lastSeen = localStorage.getItem(CHANGELOG_VERSION_KEY);
    if (lastSeen !== CURRENT_VERSION) {
      // Small delay so it doesn't fight with onboarding modal
      const timer = setTimeout(() => setOpen(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(CHANGELOG_VERSION_KEY, CURRENT_VERSION);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-yellow-400" />
            What&apos;s New — v{CURRENT_VERSION}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {entries.map((entry, i) => {
            const style = categoryStyles[entry.category];
            return (
              <div key={i} className="flex items-start gap-2.5">
                <Badge
                  variant="outline"
                  className={`text-[10px] mt-0.5 shrink-0 ${style.className}`}
                >
                  {style.label}
                </Badge>
                <div>
                  <div className="text-sm font-medium">{entry.title}</div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {entry.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <Button onClick={handleDismiss} className="w-full" size="sm">
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  );
}
