"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchAPI } from "@/lib/api";
import { Loader2 } from "lucide-react";

interface ChangelogEntry {
  id: number;
  version: string | null;
  title: string;
  description: string;
  category: "feature" | "fix" | "improvement" | "breaking";
  created_at: string;
}

const categoryStyles: Record<string, { label: string; className: string }> = {
  feature: { label: "New", className: "bg-green-500/20 text-green-400 border-green-500/30" },
  fix: { label: "Fix", className: "bg-red-500/20 text-red-400 border-red-500/30" },
  improvement: { label: "Improved", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  breaking: { label: "Breaking", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
};

// Hardcoded recent changes (supplemented by DB entries)
const recentChanges: Omit<ChangelogEntry, "id">[] = [
  {
    version: "0.9.2",
    title: "Bug reporting & feature requests",
    description: "Submit bug reports and feature requests directly from the dashboard. Mark cases as bugged for investigation.",
    category: "feature",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.9.2",
    title: "Onboarding guide",
    description: "New Getting Started page with workflow walkthrough and tips for new users.",
    category: "feature",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.9.1",
    title: "System health detail drill-down",
    description: "Click on any system health metric to see the actual cases, proposals, or errors behind the number.",
    category: "improvement",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.9.1",
    title: "Batch case creation",
    description: "Send the same FOIA request to multiple agencies at once from the Cases page.",
    category: "feature",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.9.0",
    title: "Error tracking & audit trail",
    description: "All system errors are now captured with full context. Activity log tracks who did what and when.",
    category: "improvement",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.9.0",
    title: "Email attachment support",
    description: "Attach files to outbound FOIA emails. Upload from the proposal approval screen.",
    category: "feature",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.8.9",
    title: "Portal submission history",
    description: "Durable record of every portal submission attempt with status and confirmation tracking.",
    category: "improvement",
    created_at: new Date().toISOString(),
  },
  {
    version: "0.8.9",
    title: "Decision traces",
    description: "Full AI reasoning traces captured for every decision — see exactly why the AI chose each action.",
    category: "improvement",
    created_at: new Date().toISOString(),
  },
];

export default function ChangelogPage() {
  const [dbEntries, setDbEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAPI<{ success: boolean; entries: ChangelogEntry[] }>("/feedback/changelog")
      .then((res) => {
        if (res.success) setDbEntries(res.entries);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Merge DB entries with hardcoded ones (DB entries first, deduped by title)
  const dbTitles = new Set(dbEntries.map((e) => e.title));
  const allEntries = [
    ...dbEntries,
    ...recentChanges
      .filter((c) => !dbTitles.has(c.title))
      .map((c, i) => ({ ...c, id: -(i + 1) })),
  ];

  // Group by version
  const grouped: Record<string, (ChangelogEntry & { id: number })[]> = {};
  for (const entry of allEntries) {
    const key = entry.version || "Unreleased";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry as ChangelogEntry & { id: number });
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Changelog</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Recent updates and improvements to Autobot.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([version, entries]) => (
            <div key={version}>
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="outline" className="text-xs font-mono">
                  {version}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(entries[0].created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="space-y-2 ml-1 border-l border-border pl-4">
                {entries.map((entry) => {
                  const style = categoryStyles[entry.category] || categoryStyles.improvement;
                  return (
                    <div key={entry.id} className="pb-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${style.className}`}>
                          {style.label}
                        </Badge>
                        <span className="text-sm font-medium">{entry.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                        {entry.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
