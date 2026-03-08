"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { fetchAPI } from "@/lib/api";
import { toast } from "sonner";
import { ArrowLeft, Plus, Loader2, X } from "lucide-react";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

const CASE_TEMPLATES: Array<{
  label: string;
  description: string;
  records: string[];
  details: string;
}> = [
  {
    label: "Body Camera Footage",
    description: "Request body-worn camera video from law enforcement",
    records: ["Body-worn camera footage", "In-car dashboard camera footage"],
    details: "Requesting all body-worn camera and dashboard camera footage related to the incident.",
  },
  {
    label: "911 Dispatch Records",
    description: "Request 911 call audio and dispatch logs",
    records: ["911 call audio recordings", "CAD (Computer Aided Dispatch) logs", "Dispatch communications"],
    details: "Requesting all 911 call recordings and dispatch records related to the incident.",
  },
  {
    label: "Arrest Records",
    description: "Request arrest reports and booking records",
    records: ["Arrest report", "Booking records", "Incident/offense report", "Probable cause affidavit"],
    details: "Requesting all arrest-related documentation including reports and booking records.",
  },
  {
    label: "Use of Force",
    description: "Request use-of-force reports and related documentation",
    records: ["Use of force report", "Internal affairs investigation", "Body-worn camera footage", "Witness statements"],
    details: "Requesting all documentation related to use of force during the incident.",
  },
  {
    label: "General Records",
    description: "Request incident reports and general documentation",
    records: ["Incident report", "Supplemental reports", "Witness statements"],
    details: "",
  },
];

export default function NewCasePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    case_name: "",
    subject_name: "",
    agency_name: "",
    agency_email: "",
    portal_url: "",
    state: "",
    incident_date: "",
    incident_location: "",
    additional_details: "",
  });
  const [records, setRecords] = useState<string[]>([""]);

  const set = (field: string, value: string) => setForm((f) => ({ ...f, [field]: value }));

  const addRecord = () => setRecords((r) => [...r, ""]);
  const removeRecord = (i: number) => setRecords((r) => r.filter((_, idx) => idx !== i));
  const updateRecord = (i: number, val: string) =>
    setRecords((r) => r.map((v, idx) => (idx === i ? val : v)));

  const canSubmit = form.case_name.trim() && form.subject_name.trim() && form.agency_name.trim() && (form.agency_email.trim() || form.portal_url.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const recordsList = records.map((r) => r.trim()).filter(Boolean);
      const result = await fetchAPI<{ success: boolean; case_id: number; case_name: string }>("/requests/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          requested_records: recordsList.length > 0 ? recordsList : null,
        }),
      });
      if (result.success) {
        toast.success(`Case #${result.case_id} created`);
        router.push(`/requests/detail-v2?id=${result.case_id}`);
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to create case");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold">New Case</h1>
          <p className="text-sm text-muted-foreground">Create a FOIA request manually</p>
        </div>
      </div>

      {/* Template picker */}
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
          <p className="text-[10px] text-muted-foreground mt-2">
            Click a template to pre-fill requested records. You can still edit everything.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Case info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Case Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">
                Case Name <span className="text-red-400">*</span>
              </label>
              <Input
                value={form.case_name}
                onChange={(e) => set("case_name", e.target.value)}
                placeholder="e.g. Smith shooting — body camera footage"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Subject Name <span className="text-red-400">*</span>
              </label>
              <Input
                value={form.subject_name}
                onChange={(e) => set("subject_name", e.target.value)}
                placeholder="e.g. John Smith"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Incident Date</label>
                <Input
                  type="date"
                  value={form.incident_date}
                  onChange={(e) => set("incident_date", e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Incident Location</label>
                <Input
                  value={form.incident_location}
                  onChange={(e) => set("incident_location", e.target.value)}
                  placeholder="e.g. 100 Main St, Springfield"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Agency */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Agency</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">
                Agency Name <span className="text-red-400">*</span>
              </label>
              <Input
                value={form.agency_name}
                onChange={(e) => set("agency_name", e.target.value)}
                placeholder="e.g. Springfield Police Department"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">
                  Agency Email <span className="text-red-400">*</span>
                </label>
                <Input
                  type="email"
                  value={form.agency_email}
                  onChange={(e) => set("agency_email", e.target.value)}
                  placeholder="foia@agency.gov"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">State</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={form.state}
                  onChange={(e) => set("state", e.target.value)}
                >
                  <option value="">Auto-detect</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Portal URL (if applicable)</label>
              <Input
                type="url"
                value={form.portal_url}
                onChange={(e) => set("portal_url", e.target.value)}
                placeholder="https://portal.agency.gov/foia"
              />
            </div>
            {!form.agency_email.trim() && !form.portal_url.trim() && (
              <p className="text-[10px] text-amber-400">Either email or portal URL is required</p>
            )}
          </CardContent>
        </Card>

        {/* Requested records */}
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
                  placeholder="e.g. Body camera footage, 911 dispatch audio"
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

        {/* Additional details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Additional Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              value={form.additional_details}
              onChange={(e) => set("additional_details", e.target.value)}
              placeholder="Any context, instructions, or special notes for this request..."
              rows={3}
            />
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {form.case_name.trim() && <Badge variant="secondary" className="text-[10px]">{form.case_name.trim()}</Badge>}
            {form.agency_name.trim() && <Badge variant="outline" className="text-[10px]">{form.agency_name.trim()}</Badge>}
          </div>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Create Case
          </Button>
        </div>
      </form>
    </div>
  );
}
