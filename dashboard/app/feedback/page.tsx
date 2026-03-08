"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchAPI } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import {
  Bug,
  Lightbulb,
  Loader2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Plus,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

interface FeedbackItem {
  id: number;
  type: "bug_report" | "feature_request";
  title: string;
  description: string;
  priority: string;
  status: string;
  case_id: number | null;
  created_by_email: string | null;
  created_at: string;
  resolved_notes: string | null;
}

const statusConfig: Record<string, { label: string; icon: typeof Clock; className: string }> = {
  open: { label: "Open", icon: AlertCircle, className: "text-yellow-400" },
  in_progress: { label: "In Progress", icon: Clock, className: "text-blue-400" },
  resolved: { label: "Resolved", icon: CheckCircle2, className: "text-green-400" },
  closed: { label: "Closed", icon: CheckCircle2, className: "text-muted-foreground" },
  wont_fix: { label: "Won't Fix", icon: AlertCircle, className: "text-muted-foreground" },
};

const priorityStyles: Record<string, string> = {
  low: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  medium: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function FeedbackPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState("submit");
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterType, setFilterType] = useState<string>("all");

  // Form state
  const [formType, setFormType] = useState<"bug_report" | "feature_request">("bug_report");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [caseId, setCaseId] = useState("");

  const loadItems = async () => {
    setLoading(true);
    try {
      const params = filterType !== "all" ? `?type=${filterType}` : "";
      const res = await fetchAPI<{ success: boolean; items: FeedbackItem[]; total: number }>(
        `/feedback${params}`
      );
      if (res.success) setItems(res.items);
    } catch {
      toast.error("Failed to load feedback items");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "history") loadItems();
  }, [tab, filterType]);

  const handleSubmit = async () => {
    if (!title.trim() || !description.trim()) {
      toast.error("Title and description are required");
      return;
    }
    setSubmitting(true);
    try {
      await fetchAPI("/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: formType,
          title: title.trim(),
          description: description.trim(),
          priority,
          case_id: caseId ? parseInt(caseId) : null,
        }),
      });
      toast.success(
        formType === "bug_report" ? "Bug report submitted" : "Feature request submitted"
      );
      setTitle("");
      setDescription("");
      setPriority("medium");
      setCaseId("");
      setTab("history");
    } catch (err: any) {
      toast.error(err.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Feedback</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Report bugs or request features. We read every submission.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="submit" className="flex-1 gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Submit
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-1 gap-1.5">
            <Clock className="h-3.5 w-3.5" /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="submit" className="space-y-4 mt-4">
          {/* Type selector */}
          <div className="flex gap-2">
            <Button
              variant={formType === "bug_report" ? "default" : "outline"}
              size="sm"
              onClick={() => setFormType("bug_report")}
              className="flex-1 gap-1.5"
            >
              <Bug className="h-3.5 w-3.5" /> Bug Report
            </Button>
            <Button
              variant={formType === "feature_request" ? "default" : "outline"}
              size="sm"
              onClick={() => setFormType("feature_request")}
              className="flex-1 gap-1.5"
            >
              <Lightbulb className="h-3.5 w-3.5" /> Feature Request
            </Button>
          </div>

          <Card className="p-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title" className="text-xs">
                {formType === "bug_report" ? "What went wrong?" : "What would you like?"}
              </Label>
              <Input
                id="title"
                placeholder={
                  formType === "bug_report"
                    ? "e.g., Email not sending to agency"
                    : "e.g., Bulk export case data"
                }
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description" className="text-xs">
                Details
              </Label>
              <Textarea
                id="description"
                placeholder={
                  formType === "bug_report"
                    ? "What happened? What did you expect? Steps to reproduce..."
                    : "Describe the feature and how it would help your workflow..."
                }
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="caseId" className="text-xs">
                  Related Case ID <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="caseId"
                  placeholder="e.g., 25152"
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value.replace(/\D/g, ""))}
                />
              </div>
            </div>

            <Button
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !description.trim()}
              className="w-full"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : formType === "bug_report" ? (
                <Bug className="h-4 w-4 mr-2" />
              ) : (
                <Lightbulb className="h-4 w-4 mr-2" />
              )}
              {submitting
                ? "Submitting..."
                : formType === "bug_report"
                  ? "Submit Bug Report"
                  : "Submit Feature Request"}
            </Button>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4 mt-4">
          {/* Filter */}
          <div className="flex gap-2">
            {["all", "bug_report", "feature_request"].map((t) => (
              <Button
                key={t}
                variant={filterType === t ? "default" : "outline"}
                size="sm"
                onClick={() => setFilterType(t)}
                className="text-xs"
              >
                {t === "all" ? "All" : t === "bug_report" ? "Bugs" : "Features"}
              </Button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No feedback submitted yet. Be the first!
            </Card>
          ) : (
            <div className="space-y-2">
              {items.map((item) => {
                const sc = statusConfig[item.status] || statusConfig.open;
                const StatusIcon = sc.icon;
                return (
                  <Card key={item.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {item.type === "bug_report" ? (
                            <Bug className="h-3.5 w-3.5 text-red-400 flex-shrink-0" />
                          ) : (
                            <Lightbulb className="h-3.5 w-3.5 text-yellow-400 flex-shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate">{item.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {item.description}
                        </p>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${priorityStyles[item.priority] || ""}`}
                          >
                            {item.priority}
                          </Badge>
                          <span className={`flex items-center gap-1 text-[10px] ${sc.className}`}>
                            <StatusIcon className="h-3 w-3" />
                            {sc.label}
                          </span>
                          {item.case_id && (
                            <Link
                              href={`/requests/detail-v2?id=${item.case_id}`}
                              className="text-[10px] text-blue-400 hover:text-blue-300"
                            >
                              Case #{item.case_id}
                            </Link>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(item.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        {item.resolved_notes && (
                          <p className="text-xs text-green-400/80 mt-1 italic">
                            {item.resolved_notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
