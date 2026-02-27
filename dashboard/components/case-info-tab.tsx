"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ExternalLink,
  Mail,
  MapPin,
  Calendar,
  FileText,
  DollarSign,
  Clock,
  Globe,
  Shield,
} from "lucide-react";
import type {
  RequestDetail,
  AgencySummary,
  DeadlineMilestone,
  StateDeadline,
  ScopeItem,
} from "@/lib/types";
import { formatDate } from "@/lib/utils";

interface CaseInfoTabProps {
  request: RequestDetail;
  agencySummary: AgencySummary;
  deadlineMilestones?: DeadlineMilestone[];
  stateDeadline?: StateDeadline;
}

function scopeStatusBadge(status: ScopeItem["status"]) {
  const map: Record<ScopeItem["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success" | "info" }> = {
    REQUESTED: { label: "Requested", variant: "secondary" },
    CONFIRMED_AVAILABLE: { label: "Available", variant: "success" },
    NOT_DISCLOSABLE: { label: "Not Disclosable", variant: "destructive" },
    NOT_HELD: { label: "Not Held", variant: "warning" },
    PENDING: { label: "Pending", variant: "outline" },
    DELIVERED: { label: "Delivered", variant: "success" },
    DENIED: { label: "Denied", variant: "destructive" },
    PARTIAL: { label: "Partial", variant: "info" },
    EXEMPT: { label: "Exempt", variant: "warning" },
  };
  const { label, variant } = map[status] || { label: status, variant: "outline" as const };
  return <Badge variant={variant}>{label}</Badge>;
}

function feeStatusBadge(status: string) {
  const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success" | "info" }> = {
    NONE: { variant: "outline" },
    QUOTED: { variant: "info" },
    INVOICED: { variant: "warning" },
    APPROVED: { variant: "success" },
    PAID: { variant: "success" },
  };
  const { variant } = map[status] || { variant: "outline" as const };
  return <Badge variant={variant}>{status}</Badge>;
}

export function CaseInfoTab({ request, agencySummary, deadlineMilestones, stateDeadline }: CaseInfoTabProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Section A: Case Details */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Case Details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {request.case_name && (
              <div>
                <p className="text-sm text-muted-foreground">Subject / Case Name</p>
                <p className="font-medium">{request.case_name}</p>
              </div>
            )}
            {request.incident_date && (
              <div>
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  Incident Date
                </p>
                <p className="font-medium">{formatDate(request.incident_date)}</p>
              </div>
            )}
            {request.incident_location && (
              <div>
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  Incident Location
                </p>
                <p className="font-medium">{request.incident_location}</p>
              </div>
            )}
            <div>
              <p className="text-sm text-muted-foreground">State</p>
              <p className="font-medium">{request.state}</p>
            </div>
          </div>
          {request.additional_details && (
            <>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground">Additional Details</p>
                <p className="text-sm mt-1">{request.additional_details}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Section B: Records & Scope */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Records & Scope
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {request.scope_items && request.scope_items.length > 0 ? (
            <div className="space-y-2">
              {request.scope_items.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-b-0">
                  <span className="text-sm">{item.name}</span>
                  <div className="flex items-center gap-2">
                    {scopeStatusBadge(item.status)}
                    {item.reason && (
                      <span className="text-xs text-muted-foreground max-w-[200px] truncate" title={item.reason}>
                        {item.reason}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : request.requested_records ? (
            <div>
              <p className="text-sm text-muted-foreground">Requested Records</p>
              <p className="text-sm mt-1">{request.requested_records}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No scope items recorded</p>
          )}

          {request.constraints && request.constraints.length > 0 && (
            <>
              <Separator />
              <div>
                <p className="text-sm font-medium mb-2">Constraints</p>
                {request.constraints.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 py-1.5 border-b last:border-b-0">
                    <Badge variant="outline" className="text-xs shrink-0 mt-0.5">{c.type}</Badge>
                    <div className="min-w-0">
                      <p className="text-sm">{c.description}</p>
                      <p className="text-xs text-muted-foreground">{c.source}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Section C: Delivery & Portal */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Delivery & Portal
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {request.agency_email && (
              <div>
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  Agency Email
                </p>
                <a
                  href={`mailto:${request.agency_email}`}
                  className="text-sm text-primary hover:underline"
                >
                  {request.agency_email}
                </a>
              </div>
            )}
            {request.portal_url && (
              <div>
                <p className="text-sm text-muted-foreground">Portal URL</p>
                <a
                  href={request.portal_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                >
                  Open Portal
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {request.portal_provider && (
              <div>
                <p className="text-sm text-muted-foreground">Portal Provider</p>
                <Badge variant="outline">{request.portal_provider}</Badge>
              </div>
            )}
            {request.portal_request_number && (
              <div>
                <p className="text-sm text-muted-foreground">Portal Request #</p>
                <p className="text-sm font-medium">{request.portal_request_number}</p>
              </div>
            )}
            {request.last_portal_status && (
              <div>
                <p className="text-sm text-muted-foreground">Portal Status</p>
                <Badge variant="info">{request.last_portal_status}</Badge>
              </div>
            )}
            {agencySummary.submission_method && (
              <div>
                <p className="text-sm text-muted-foreground">Submission Method</p>
                <Badge variant="secondary">{agencySummary.submission_method}</Badge>
              </div>
            )}
          </div>
          {request.last_portal_task_url && (
            <div>
              <p className="text-sm text-muted-foreground">Skyvern Run</p>
              <a
                href={request.last_portal_task_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline inline-flex items-center gap-1"
              >
                View Run
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {!request.agency_email && !request.portal_url && !request.portal_provider && (
            <p className="text-sm text-muted-foreground">No delivery details recorded</p>
          )}
        </CardContent>
      </Card>

      {/* Section D: Fee Quote (only if exists) */}
      {request.fee_quote && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Fee Quote
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-sm text-muted-foreground">Amount</p>
                <p className="font-medium text-lg">
                  {request.fee_quote.currency === "USD" ? "$" : request.fee_quote.currency}
                  {request.fee_quote.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                {feeStatusBadge(request.fee_quote.status)}
              </div>
              {request.fee_quote.deposit_amount != null && request.fee_quote.deposit_amount > 0 && (
                <div>
                  <p className="text-sm text-muted-foreground">Deposit Required</p>
                  <p className="font-medium">
                    ${request.fee_quote.deposit_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </p>
                </div>
              )}
              {request.fee_quote.waiver_possible && (
                <div>
                  <p className="text-sm text-muted-foreground">Fee Waiver</p>
                  <Badge variant="info">Waiver Possible</Badge>
                </div>
              )}
            </div>

            {request.fee_quote.breakdown && request.fee_quote.breakdown.length > 0 && (
              <>
                <Separator />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {request.fee_quote.breakdown.map((item, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">
                          {item.item}
                          {item.description && (
                            <span className="text-xs text-muted-foreground block">{item.description}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {item.quantity ?? "—"} {item.unit_type?.toLowerCase() ?? ""}
                        </TableCell>
                        <TableCell className="text-sm">
                          {item.unit_rate != null ? `$${item.unit_rate.toFixed(2)}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-right">
                          ${item.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}

            {request.fee_quote.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground">Notes</p>
                  <p className="text-sm mt-1">{request.fee_quote.notes}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Section E: Deadlines */}
      {(stateDeadline || (deadlineMilestones && deadlineMilestones.length > 0)) && (
        <Card className={!request.fee_quote ? "lg:col-span-2" : ""}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Deadlines
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {stateDeadline && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">State Deadline</p>
                  <p className="font-medium">{stateDeadline.response_days} business days</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Statute</p>
                  <p className="text-sm">{stateDeadline.statute_citation}</p>
                </div>
              </div>
            )}

            {deadlineMilestones && deadlineMilestones.length > 0 && (
              <>
                {stateDeadline && <Separator />}
                <div className="space-y-2">
                  <p className="text-sm font-medium">Milestones</p>
                  {deadlineMilestones.map((m, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-b-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={m.is_met ? "success" : m.type === "STATUTORY_DUE" ? "warning" : "outline"}
                          className="text-xs"
                        >
                          {m.type.replace(/_/g, " ")}
                        </Badge>
                        <span className="text-sm">{m.label}</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(m.date)}
                        {m.citation && (
                          <span className="text-xs ml-2">({m.citation})</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
