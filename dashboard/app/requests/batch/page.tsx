"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { fetchAPI } from "@/lib/api";
import { toast } from "sonner";
import {
  ArrowLeft,
  Plus,
  Loader2,
  X,
  Search,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

interface Agency {
  name: string;
  email: string;
  portal_url: string;
  portal_provider: string;
  state: string;
  /** From directory search — display-only */
  source?: "directory" | "manual";
}

interface BatchResult {
  success: boolean;
  batch_id: string;
  cases_created: number;
  errors_count: number;
  cases: Array<{ case_id: number; agency_name: string; state: string; status: string }>;
  errors?: Array<{ index: number; agency_name: string; error: string }>;
}

const CASE_TEMPLATES = [
  {
    label: "Body Camera Footage",
    records: ["Body-worn camera footage", "In-car dashboard camera footage"],
    details: "Requesting all body-worn camera and dashboard camera footage related to the incident.",
  },
  {
    label: "911 Dispatch Records",
    records: ["911 call audio recordings", "CAD (Computer Aided Dispatch) logs", "Dispatch communications"],
    details: "Requesting all 911 call recordings and dispatch records related to the incident.",
  },
  {
    label: "Arrest Records",
    records: ["Arrest report", "Booking records", "Incident/offense report", "Probable cause affidavit"],
    details: "Requesting all arrest-related documentation including reports and booking records.",
  },
  {
    label: "Use of Force",
    records: ["Use of force report", "Internal affairs investigation", "Body-worn camera footage", "Witness statements"],
    details: "Requesting all documentation related to use of force during the incident.",
  },
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

export default function BatchCreatePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);

  // Template fields
  const [template, setTemplate] = useState({
    case_name: "",
    subject_name: "",
    incident_date: "",
    incident_location: "",
    additional_details: "",
  });
  const [records, setRecords] = useState<string[]>([""]);

  // Agency list
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [manualAgency, setManualAgency] = useState<Agency>({
    name: "", email: "", portal_url: "", portal_provider: "", state: "", source: "manual",
  });

  // Directory search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const set = (field: string, value: string) =>
    setTemplate((t) => ({ ...t, [field]: value }));

  const addRecord = () => setRecords((r) => [...r, ""]);
  const removeRecord = (i: number) => setRecords((r) => r.filter((_, idx) => idx !== i));
  const updateRecord = (i: number, val: string) =>
    setRecords((r) => r.map((v, idx) => (idx === i ? val : v)));

  const removeAgency = (i: number) => setAgencies((a) => a.filter((_, idx) => idx !== i));

  const addManualAgency = () => {
    if (!manualAgency.name.trim()) return;
    if (!manualAgency.email.trim() && !manualAgency.portal_url.trim()) return;
    setAgencies((a) => [...a, { ...manualAgency, source: "manual" }]);
    setManualAgency({ name: "", email: "", portal_url: "", portal_provider: "", state: "", source: "manual" });
  };

  const searchAgencies = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const params = new URLSearchParams({ search: searchQuery, limit: "20" });
      if (searchState) params.set("state", searchState);
      const data = await fetchAPI<{ agencies: any[] }>(`/agencies?${params}`);
      setSearchResults(data.agencies || []);
    } catch {
      toast.error("Failed to search agencies");
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searchState]);

  const addFromDirectory = (dir: any) => {
    const already = agencies.some(
      (a) => a.name.toLowerCase() === (dir.name || "").toLowerCase() && a.state === dir.state
    );
    if (already) {
      toast.info(`${dir.name} already added`);
      return;
    }
    setAgencies((a) => [
      ...a,
      {
        name: dir.name,
        email: dir.email_main || dir.email_foia || "",
        portal_url: dir.portal_url || "",
        portal_provider: dir.portal_provider || "",
        state: dir.state || "",
        source: "directory",
      },
    ]);
  };

  const canSubmit =
    template.case_name.trim() &&
    template.subject_name.trim() &&
    agencies.length > 0 &&
    agencies.every((a) => a.name.trim() && (a.email.trim() || a.portal_url.trim()));

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const recordsList = records.map((r) => r.trim()).filter(Boolean);
      const data = await fetchAPI<BatchResult>("/requests/batch", {
        method: "POST",
        body: JSON.stringify({
          template: {
            ...template,
            requested_records: recordsList.length > 0 ? recordsList : null,
          },
          agencies: agencies.map((a) => ({
            name: a.name,
            email: a.email,
            portal_url: a.portal_url,
            portal_provider: a.portal_provider,
            state: a.state,
          })),
        }),
      });
      setResult(data);
      toast.success(`Created ${data.cases_created} cases`);
    } catch (err: any) {
      toast.error(err?.message || "Batch creation failed");
    } finally {
      setSubmitting(false);
    }
  };

  // Result screen
  if (result) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 text-green-500" />
          <div>
            <h1 className="text-xl font-bold">Batch Created</h1>
            <p className="text-sm text-muted-foreground">
              {result.cases_created} cases created
              {result.errors_count > 0 && `, ${result.errors_count} failed`}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Cases</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {result.cases.map((c) => (
                <div
                  key={c.case_id}
                  className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      #{c.case_id}
                    </Badge>
                    <span>{c.agency_name}</span>
                    {c.state && (
                      <Badge variant="secondary" className="text-[10px]">
                        {c.state}
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => router.push(`/requests/detail-v2?id=${c.case_id}`)}
                  >
                    View
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {result.errors && result.errors.length > 0 && (
          <Card className="border-red-500/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-red-400 flex items-center gap-2">
                <AlertCircle className="h-4 w-4" /> Errors
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 text-sm">
                {result.errors.map((e, i) => (
                  <div key={i} className="text-red-400">
                    {e.agency_name}: {e.error}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/requests")}>
            Back to Requests
          </Button>
          <Button
            onClick={() => {
              setResult(null);
              setAgencies([]);
            }}
          >
            Create Another Batch
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold">Batch Request</h1>
          <p className="text-sm text-muted-foreground">
            Send the same request to multiple agencies
          </p>
        </div>
      </div>

      {/* Templates */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Start from Template</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {CASE_TEMPLATES.map((t) => (
              <Button
                key={t.label}
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => {
                  setRecords(t.records);
                  if (t.details) set("additional_details", t.details);
                }}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Case Template */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Case Details (shared template)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">
              Case Name <span className="text-red-400">*</span>
            </label>
            <Input
              value={template.case_name}
              onChange={(e) => set("case_name", e.target.value)}
              placeholder="e.g. Smith shooting — multi-agency request"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Subject Name <span className="text-red-400">*</span>
            </label>
            <Input
              value={template.subject_name}
              onChange={(e) => set("subject_name", e.target.value)}
              placeholder="e.g. John Smith"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Incident Date</label>
              <Input
                type="date"
                value={template.incident_date}
                onChange={(e) => set("incident_date", e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Incident Location</label>
              <Input
                value={template.incident_location}
                onChange={(e) => set("incident_location", e.target.value)}
                placeholder="e.g. 100 Main St, Springfield"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Requested Records */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            Requested Records
            <Button type="button" variant="ghost" size="sm" onClick={addRecord}>
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {records.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={r}
                onChange={(e) => updateRecord(i, e.target.value)}
                placeholder="e.g. Body camera footage"
              />
              {records.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => removeRecord(i)}>
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Additional Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Additional Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={template.additional_details}
            onChange={(e) => set("additional_details", e.target.value)}
            placeholder="Context, instructions, or notes shared across all agencies..."
            rows={3}
          />
        </CardContent>
      </Card>

      {/* Agency Search */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Search Agency Directory</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name..."
              onKeyDown={(e) => e.key === "Enter" && searchAgencies()}
            />
            <select
              className="flex h-9 w-24 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
              value={searchState}
              onChange={(e) => setSearchState(e.target.value)}
            >
              <option value="">All</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={searchAgencies}
              disabled={searching}
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          {searchResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto border rounded-md divide-y divide-border/50">
              {searchResults.map((dir) => (
                <div
                  key={dir.id}
                  className="flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 cursor-pointer"
                  onClick={() => addFromDirectory(dir)}
                >
                  <div>
                    <span className="font-medium">{dir.name}</span>
                    {dir.state && (
                      <Badge variant="secondary" className="ml-2 text-[10px]">
                        {dir.state}
                      </Badge>
                    )}
                    <span className="text-muted-foreground text-xs ml-2">
                      {dir.submission_method === "PORTAL" ? "Portal" : dir.email_main || "No email"}
                    </span>
                  </div>
                  <Plus className="h-3 w-3 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual Agency Entry */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Add Agency Manually</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={manualAgency.name}
              onChange={(e) => setManualAgency((a) => ({ ...a, name: e.target.value }))}
              placeholder="Agency name *"
            />
            <Input
              value={manualAgency.email}
              onChange={(e) => setManualAgency((a) => ({ ...a, email: e.target.value }))}
              placeholder="Email"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Input
              value={manualAgency.portal_url}
              onChange={(e) => setManualAgency((a) => ({ ...a, portal_url: e.target.value }))}
              placeholder="Portal URL"
            />
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm"
              value={manualAgency.state}
              onChange={(e) => setManualAgency((a) => ({ ...a, state: e.target.value }))}
            >
              <option value="">State</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              onClick={addManualAgency}
              disabled={!manualAgency.name.trim() || (!manualAgency.email.trim() && !manualAgency.portal_url.trim())}
            >
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Selected Agencies */}
      {agencies.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              Selected Agencies ({agencies.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {agencies.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate font-medium">{a.name}</span>
                    {a.state && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {a.state}
                      </Badge>
                    )}
                    <span className="text-muted-foreground text-xs truncate">
                      {a.portal_url ? "Portal" : a.email}
                    </span>
                    {a.source === "directory" && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        Directory
                      </Badge>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAgency(i)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Submit */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {template.case_name.trim() && (
            <Badge variant="secondary" className="text-[10px]">
              {template.case_name.trim()}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {agencies.length} {agencies.length === 1 ? "agency" : "agencies"}
          </Badge>
        </div>
        <Button onClick={handleSubmit} disabled={!canSubmit || submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 mr-1" />
          )}
          Create {agencies.length} {agencies.length === 1 ? "Case" : "Cases"}
        </Button>
      </div>
    </div>
  );
}
