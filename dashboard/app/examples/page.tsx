"use client";

import { useState } from "react";
import useSWR from "swr";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fetcher } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  FileText,
  Filter,
} from "lucide-react";

interface SuccessfulExample {
  id: number;
  proposal_id: number;
  case_id: number | null;
  action_type: string;
  classification: string | null;
  agency_name: string | null;
  agency_type: string | null;
  state_code: string | null;
  requested_records: string | null;
  draft_subject: string | null;
  draft_body_text: string | null;
  human_edited: boolean;
  approved_by: string | null;
  outcome: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

interface ExamplesResponse {
  success: boolean;
  total: number;
  examples: SuccessfulExample[];
  filters: {
    classifications: string[] | null;
    action_types: string[] | null;
    state_codes: string[] | null;
    agency_types: string[] | null;
  };
}

const ALL_VALUE = "__all__";

function ActionBadge({ action }: { action: string }) {
  const colorMap: Record<string, string> = {
    SEND_INITIAL_REQUEST: "text-blue-400 bg-blue-500/10",
    SEND_FOLLOWUP: "text-amber-400 bg-amber-500/10",
    SEND_REBUTTAL: "text-red-400 bg-red-500/10",
    SEND_APPEAL: "text-red-400 bg-red-500/10",
    SEND_CLARIFICATION: "text-purple-400 bg-purple-500/10",
    SEND_FEE_WAIVER_REQUEST: "text-emerald-400 bg-emerald-500/10",
    NEGOTIATE_FEE: "text-emerald-400 bg-emerald-500/10",
    SUBMIT_PORTAL: "text-cyan-400 bg-cyan-500/10",
    RESEARCH_AGENCY: "text-violet-400 bg-violet-500/10",
  };
  const color = colorMap[action] || "text-muted-foreground bg-muted";
  return (
    <Badge variant="outline" className={cn("text-xs font-mono", color)}>
      {action}
    </Badge>
  );
}

function ExampleRow({ example }: { example: SuccessfulExample }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <TableRow className="cursor-pointer hover:bg-muted/50">
        <TableCell>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-1 text-left w-full">
              {open ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm truncate max-w-[200px]">
                {example.agency_name || "Unknown Agency"}
              </span>
            </button>
          </CollapsibleTrigger>
        </TableCell>
        <TableCell>
          <Badge variant="secondary" className="text-xs font-mono">
            {example.classification || "N/A"}
          </Badge>
        </TableCell>
        <TableCell>
          <ActionBadge action={example.action_type} />
        </TableCell>
        <TableCell>
          <span className="text-xs text-muted-foreground">
            {example.agency_type || "N/A"}
          </span>
        </TableCell>
        <TableCell>
          <span className="text-xs font-mono text-muted-foreground">
            {example.state_code || "--"}
          </span>
        </TableCell>
        <TableCell>
          {example.human_edited ? (
            <Badge variant="outline" className="text-xs text-amber-400 bg-amber-500/10">
              Edited
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-green-400 bg-green-500/10">
              As-is
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <span className="text-xs text-muted-foreground">
            {formatDate(example.created_at)}
          </span>
        </TableCell>
      </TableRow>
      <CollapsibleContent asChild>
        <tr>
          <td colSpan={7} className="p-0">
            <div className="border-t border-b bg-muted/30 px-6 py-4 space-y-3">
              {example.draft_subject && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Subject</p>
                  <p className="text-sm">{example.draft_subject}</p>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Draft Body</p>
                <pre className="text-sm whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-y-auto border rounded-md p-3 bg-background">
                  {example.draft_body_text || "(empty)"}
                </pre>
              </div>
              {example.requested_records && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Requested Records</p>
                  <p className="text-sm text-muted-foreground">{example.requested_records}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-1">
                {example.case_id && (
                  <span>Case #{example.case_id}</span>
                )}
                {example.proposal_id && (
                  <span>Proposal #{example.proposal_id}</span>
                )}
                {example.approved_by && (
                  <span>Approved by: {example.approved_by}</span>
                )}
              </div>
            </div>
          </td>
        </tr>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ExamplesPage() {
  const [classification, setClassification] = useState<string>(ALL_VALUE);
  const [actionType, setActionType] = useState<string>(ALL_VALUE);
  const [stateCode, setStateCode] = useState<string>(ALL_VALUE);
  const [agencyType, setAgencyType] = useState<string>(ALL_VALUE);

  const params = new URLSearchParams();
  if (classification !== ALL_VALUE) params.set("classification", classification);
  if (actionType !== ALL_VALUE) params.set("action_type", actionType);
  if (stateCode !== ALL_VALUE) params.set("state_code", stateCode);
  if (agencyType !== ALL_VALUE) params.set("agency_type", agencyType);
  params.set("limit", "100");

  const query = params.toString();

  const {
    data,
    isLoading,
    mutate,
  } = useSWR<ExamplesResponse>(
    `/eval/examples${query ? `?${query}` : ""}`,
    fetcher,
    { refreshInterval: 60000 }
  );

  const examples = data?.examples || [];
  const total = data?.total ?? 0;
  const filters = data?.filters;

  const hasActiveFilters =
    classification !== ALL_VALUE ||
    actionType !== ALL_VALUE ||
    stateCode !== ALL_VALUE ||
    agencyType !== ALL_VALUE;

  const clearFilters = () => {
    setClassification(ALL_VALUE);
    setActionType(ALL_VALUE);
    setStateCode(ALL_VALUE);
    setAgencyType(ALL_VALUE);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            Successful Examples
            <Badge variant="secondary" className="text-sm font-mono ml-1">
              {total}
            </Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            Auto-captured approved drafts used as few-shot examples in AI prompts.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => mutate()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2"
                onClick={clearFilters}
              >
                Clear all
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Classification</label>
              <Select value={classification} onValueChange={setClassification}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All</SelectItem>
                  {filters?.classifications?.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Action Type</label>
              <Select value={actionType} onValueChange={setActionType}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All</SelectItem>
                  {filters?.action_types?.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">State</label>
              <Select value={stateCode} onValueChange={setStateCode}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All</SelectItem>
                  {filters?.state_codes?.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Agency Type</label>
              <Select value={agencyType} onValueChange={setAgencyType}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_VALUE}>All</SelectItem>
                  {filters?.agency_types?.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Examples Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Examples
            {hasActiveFilters && (
              <span className="text-xs text-muted-foreground font-normal">
                (showing {examples.length} of {total})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : examples.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No successful examples found.</p>
              <p className="text-xs mt-1">
                Examples are auto-captured when proposals are approved.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[700px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Agency</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Agency Type</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Captured</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {examples.map((example) => (
                    <ExampleRow key={example.id} example={example} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
