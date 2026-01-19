"use client";

import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetcher } from "@/lib/api";
import type { AgencyDetailResponse } from "@/lib/types";
import { formatDate, formatCurrency } from "@/lib/utils";
import {
  ArrowLeft,
  Building,
  Globe,
  Mail,
  Clock,
  DollarSign,
  FileText,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
} from "lucide-react";

export default function AgencyDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data, error, isLoading } = useSWR<AgencyDetailResponse>(
    `/agencies/${id}`,
    fetcher
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load agency</p>
        <p className="text-sm text-muted-foreground">
          {error?.message || "Agency not found"}
        </p>
        <Link
          href="/agencies"
          className="text-primary hover:underline mt-4 inline-block"
        >
          Back to Agencies
        </Link>
      </div>
    );
  }

  const { agency } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/agencies")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <Building className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-bold">{agency.name}</h1>
          </div>
          <p className="text-muted-foreground">{agency.state}</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <FileText className="h-4 w-4" />
              Total Requests
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agency.stats.total_requests}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <CheckCircle className="h-4 w-4" />
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {agency.stats.completed_requests}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Clock className="h-4 w-4" />
              Avg Response
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {agency.stats.avg_response_days !== null
                ? `${agency.stats.avg_response_days}d`
                : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <DollarSign className="h-4 w-4" />
              Total Fees
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {agency.stats.total_fees > 0
                ? formatCurrency(agency.stats.total_fees)
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Submission Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Submission Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Method</span>
              <Badge variant="outline" className="gap-1">
                {agency.submission_method === "PORTAL" ? (
                  <Globe className="h-3 w-3" />
                ) : (
                  <Mail className="h-3 w-3" />
                )}
                {agency.submission_method}
              </Badge>
            </div>
            {agency.portal_url && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Portal</span>
                <a
                  href={agency.portal_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline flex items-center gap-1"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {agency.portal_provider && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Provider</span>
                <span>{agency.portal_provider}</span>
              </div>
            )}
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Forms Required</span>
              <Badge variant={agency.submission_details.forms_required ? "default" : "outline"}>
                {agency.submission_details.forms_required ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">ID Required</span>
              <Badge variant={agency.submission_details.id_required ? "default" : "outline"}>
                {agency.submission_details.id_required ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Notarization</span>
              <Badge variant={agency.submission_details.notarization_required ? "default" : "outline"}>
                {agency.submission_details.notarization_required ? "Yes" : "No"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Fee Behavior */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fee Behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Requests with Fees</span>
              <span className="font-medium">{agency.stats.has_fees}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total Fees Paid</span>
              <span className="font-medium">
                {agency.stats.total_fees > 0
                  ? formatCurrency(agency.stats.total_fees)
                  : "—"}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Typical Range</span>
              <span>{agency.fee_behavior.typical_fee_range || "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Waiver Success</span>
              <span>
                {agency.fee_behavior.waiver_success_rate !== null
                  ? `${Math.round(agency.fee_behavior.waiver_success_rate * 100)}%`
                  : "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Automation Rules */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Automation Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Default Mode</span>
              <Badge variant="outline">{agency.default_autopilot_mode}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Pending Review</span>
              <Badge
                variant={agency.stats.pending_review > 0 ? "warning" : "outline"}
              >
                {agency.stats.pending_review}
              </Badge>
            </div>
            <Separator />
            {agency.notes && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{agency.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Requests</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Case Name</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Response</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agency.recent_requests.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    No requests yet
                  </TableCell>
                </TableRow>
              ) : (
                agency.recent_requests.map((req) => (
                  <TableRow
                    key={req.id}
                    className="cursor-pointer"
                    onClick={() =>
                      (window.location.href = `/requests/${req.id}`)
                    }
                  >
                    <TableCell className="font-medium">{req.id}</TableCell>
                    <TableCell>{req.case_name}</TableCell>
                    <TableCell>{req.subject_name || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{req.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(req.send_date)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(req.last_response_date)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
