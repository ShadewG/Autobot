"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetcher, fetchAPI } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  BookOpen,
  Plus,
  Pencil,
  RefreshCw,
  Loader2,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface Lesson {
  id: number;
  category: string;
  trigger_pattern: string;
  lesson: string;
  source: string;
  source_case_id: number | null;
  priority: number;
  active: boolean;
  times_applied: number;
  created_at: string;
  updated_at: string;
}

interface LessonsResponse {
  success: boolean;
  lessons: Lesson[];
}

interface ParseResponse {
  success: boolean;
  parsed: {
    category: string;
    trigger_pattern: string;
    lesson: string;
    priority: number;
    recommended_action?: string;
  };
}

// ── Constants ──────────────────────────────────────────────────────────────

const CATEGORIES = ["general", "denial", "portal", "fee", "followup", "agency", "bwc"] as const;

const SOURCE_COLORS: Record<string, string> = {
  manual: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  auto: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

const CATEGORY_COLORS: Record<string, string> = {
  general: "bg-gray-500/10 text-gray-400",
  denial: "bg-red-500/10 text-red-400",
  portal: "bg-cyan-500/10 text-cyan-400",
  fee: "bg-amber-500/10 text-amber-400",
  followup: "bg-purple-500/10 text-purple-400",
  agency: "bg-green-500/10 text-green-400",
  bwc: "bg-orange-500/10 text-orange-400",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  const colors = SOURCE_COLORS[source] || "bg-gray-500/10 text-gray-400";
  return (
    <Badge variant="outline" className={cn("text-xs capitalize", colors)}>
      {source}
    </Badge>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] || "bg-gray-500/10 text-gray-400";
  return (
    <Badge variant="outline" className={cn("text-xs capitalize font-mono", colors)}>
      {category}
    </Badge>
  );
}

function PriorityIndicator({ priority }: { priority: number }) {
  const color =
    priority >= 8
      ? "text-red-400"
      : priority >= 5
      ? "text-amber-400"
      : "text-gray-400";
  return (
    <span className={cn("text-xs font-mono tabular-nums", color)} title={`Priority: ${priority}/10`}>
      P{priority}
    </span>
  );
}

// ── Form State ─────────────────────────────────────────────────────────────

interface LessonFormState {
  lesson: string;
  category: string;
  trigger_pattern: string;
  priority: number;
}

const EMPTY_FORM: LessonFormState = {
  lesson: "",
  category: "general",
  trigger_pattern: "",
  priority: 7,
};

// ── Page Component ─────────────────────────────────────────────────────────

export default function LessonsPage() {
  // Data fetching — fetch all (active+inactive) so we can toggle
  const {
    data,
    mutate,
    isLoading,
  } = useSWR<LessonsResponse>("/monitor/lessons?active=false", fetcher, {
    refreshInterval: 30000,
  });

  const allLessons = data?.lessons || [];

  // Filter state
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<string>("active");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [form, setForm] = useState<LessonFormState>(EMPTY_FORM);
  const [parseText, setParseText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // ── Filtering ──

  const filteredLessons = useMemo(() => {
    let result = allLessons;

    // Active filter
    if (activeFilter === "active") {
      result = result.filter((l) => l.active);
    } else if (activeFilter === "inactive") {
      result = result.filter((l) => !l.active);
    }

    // Source filter
    if (sourceFilter !== "all") {
      result = result.filter((l) => l.source === sourceFilter);
    }

    // Text search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.lesson.toLowerCase().includes(q) ||
          l.trigger_pattern.toLowerCase().includes(q) ||
          l.category.toLowerCase().includes(q)
      );
    }

    return result;
  }, [allLessons, search, sourceFilter, activeFilter]);

  // ── Summary stats ──

  const stats = useMemo(() => {
    const total = allLessons.length;
    const active = allLessons.filter((l) => l.active).length;
    const manual = allLessons.filter((l) => l.source === "manual").length;
    const auto = allLessons.filter((l) => l.source === "auto").length;
    return { total, active, manual, auto };
  }, [allLessons]);

  // ── Handlers ──

  const openAddDialog = () => {
    setEditingLesson(null);
    setForm(EMPTY_FORM);
    setParseText("");
    setDialogOpen(true);
  };

  const openEditDialog = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setForm({
      lesson: lesson.lesson,
      category: lesson.category,
      trigger_pattern: lesson.trigger_pattern,
      priority: lesson.priority,
    });
    setParseText("");
    setDialogOpen(true);
  };

  const handleParseWithAI = async () => {
    if (!parseText.trim()) return;
    setParsing(true);
    try {
      const result = await fetchAPI<ParseResponse>("/monitor/lessons/parse", {
        method: "POST",
        body: JSON.stringify({ text: parseText.trim() }),
      });
      if (result.success && result.parsed) {
        setForm({
          lesson: result.parsed.lesson,
          category: result.parsed.category,
          trigger_pattern: result.parsed.trigger_pattern,
          priority: result.parsed.priority || 7,
        });
        toast.success("AI parsed the lesson successfully");
      }
    } catch (e: any) {
      console.error("Failed to parse lesson:", e);
      toast.error(e?.message || "Failed to parse lesson with AI");
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    if (!form.lesson.trim() || !form.trigger_pattern.trim()) {
      toast.error("Lesson text and trigger pattern are required");
      return;
    }
    setSaving(true);
    try {
      if (editingLesson) {
        // Update
        await fetchAPI(`/monitor/lessons/${editingLesson.id}`, {
          method: "PUT",
          body: JSON.stringify({
            lesson: form.lesson,
            category: form.category,
            trigger_pattern: form.trigger_pattern,
            priority: form.priority,
          }),
        });
        toast.success("Lesson updated");
      } else {
        // Create
        await fetchAPI("/monitor/lessons", {
          method: "POST",
          body: JSON.stringify({
            lesson: form.lesson,
            category: form.category,
            trigger_pattern: form.trigger_pattern,
            priority: form.priority,
          }),
        });
        toast.success("Lesson created");
      }
      setDialogOpen(false);
      mutate();
    } catch (e: any) {
      console.error("Failed to save lesson:", e);
      toast.error(e?.message || "Failed to save lesson");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (lesson: Lesson) => {
    setTogglingId(lesson.id);
    try {
      await fetchAPI(`/monitor/lessons/${lesson.id}`, {
        method: "PUT",
        body: JSON.stringify({ active: !lesson.active }),
      });
      mutate();
      toast.success(lesson.active ? "Lesson deactivated" : "Lesson activated");
    } catch (e: any) {
      console.error("Failed to toggle lesson:", e);
      toast.error(e?.message || "Failed to update lesson");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (lesson: Lesson) => {
    if (!confirm(`Delete lesson #${lesson.id}? This cannot be undone.`)) return;
    setDeletingId(lesson.id);
    try {
      await fetchAPI(`/monitor/lessons/${lesson.id}`, {
        method: "DELETE",
      });
      mutate();
      toast.success("Lesson deleted");
    } catch (e: any) {
      console.error("Failed to delete lesson:", e);
      toast.error(e?.message || "Failed to delete lesson");
    } finally {
      setDeletingId(null);
    }
  };

  // ── Render ──

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            AI Decision Lessons
          </h1>
          <p className="text-sm text-muted-foreground">
            Rules and patterns injected into AI decision prompts. Manual rules and auto-learned lessons from outcomes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button size="sm" onClick={openAddDialog}>
            <Plus className="h-4 w-4 mr-1" />
            Add Lesson
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Total Lessons</p>
            <p className="text-2xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Active</p>
            <p className="text-2xl font-bold text-green-400">{stats.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Manual</p>
            <p className="text-2xl font-bold text-blue-400">{stats.manual}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Auto-Learned</p>
            <p className="text-2xl font-bold text-amber-400">{stats.auto}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search lessons..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="auto">Auto</SelectItem>
          </SelectContent>
        </Select>
        <Select value={activeFilter} onValueChange={setActiveFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {filteredLessons.length} lesson{filteredLessons.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Lessons Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredLessons.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No lessons found.</p>
              <p className="text-xs mt-1">
                Add a manual lesson or let the system auto-learn from outcomes.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[45%]">Lesson</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="w-[80px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLessons.map((lesson) => (
                    <TableRow
                      key={lesson.id}
                      className={cn(
                        "group",
                        !lesson.active && "opacity-50"
                      )}
                    >
                      <TableCell>
                        <div className="space-y-1">
                          <p className="text-sm leading-snug">{lesson.lesson}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate max-w-[400px]" title={lesson.trigger_pattern}>
                            {lesson.trigger_pattern}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <CategoryBadge category={lesson.category} />
                      </TableCell>
                      <TableCell>
                        <SourceBadge source={lesson.source} />
                      </TableCell>
                      <TableCell>
                        <PriorityIndicator priority={lesson.priority} />
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {lesson.times_applied}x
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(lesson.created_at)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={lesson.active}
                          disabled={togglingId === lesson.id}
                          onCheckedChange={() => handleToggleActive(lesson)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditDialog(lesson)}
                            title="Edit lesson"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(lesson)}
                            disabled={deletingId === lesson.id}
                            title="Delete lesson"
                            className="text-red-400 hover:text-red-300"
                          >
                            {deletingId === lesson.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              {editingLesson ? "Edit Lesson" : "Add Lesson"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* AI Parse Section (only for new lessons) */}
            {!editingLesson && (
              <div className="space-y-2 border rounded-md p-3 bg-muted/30">
                <Label className="text-xs text-muted-foreground">
                  Describe a lesson in plain English and let AI structure it
                </Label>
                <Textarea
                  placeholder='e.g. "When an agency says records were destroyed due to retention policy, do not send a rebuttal — just close the case"'
                  value={parseText}
                  onChange={(e) => setParseText(e.target.value)}
                  rows={3}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleParseWithAI}
                  disabled={parsing || !parseText.trim()}
                >
                  {parsing ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-1" />
                  )}
                  Parse with AI
                </Button>
              </div>
            )}

            {/* Structured Fields */}
            <div className="space-y-3">
              <div>
                <Label htmlFor="lesson-text">Lesson Text</Label>
                <Textarea
                  id="lesson-text"
                  placeholder="Precise instruction for the AI decision engine..."
                  value={form.lesson}
                  onChange={(e) => setForm({ ...form, lesson: e.target.value })}
                  rows={3}
                  className="mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="category">Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={(v) => setForm({ ...form, category: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="priority">Priority (1-10)</Label>
                  <Input
                    id="priority"
                    type="number"
                    min={1}
                    max={10}
                    value={form.priority}
                    onChange={(e) =>
                      setForm({ ...form, priority: Math.max(1, Math.min(10, parseInt(e.target.value) || 7)) })
                    }
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="trigger-pattern">
                  Trigger Pattern
                  <span className="text-xs text-muted-foreground font-normal ml-1">
                    (space-separated keywords)
                  </span>
                </Label>
                <Input
                  id="trigger-pattern"
                  placeholder="e.g. denial ongoing_investigation bwc_involved"
                  value={form.trigger_pattern}
                  onChange={(e) => setForm({ ...form, trigger_pattern: e.target.value })}
                  className="mt-1 font-mono text-sm"
                />
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !form.lesson.trim() || !form.trigger_pattern.trim()}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : null}
                {editingLesson ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
