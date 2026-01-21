"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDate, cn } from "@/lib/utils";
import type { ThreadMessage } from "@/lib/types";
import {
  Mail,
  Calendar,
  User,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  DollarSign,
  Clock,
  FileText,
  RefreshCw,
  Flag,
  MoreHorizontal,
  Paperclip,
  Shield,
  Scale,
  ExternalLink,
} from "lucide-react";

interface ParsedAnalysis {
  classification?: {
    type: string;
    confidence: number;
  };
  intent?: string;
  sentiment?: string;
  extracted_fee_amount?: number;
  extracted_due_date?: string;
  detected_statutes?: string[];
  detected_exemptions?: string[];
  portal_instructions?: string;
  key_points?: string[];
  risk_flags?: string[];
}

interface InboundEvidencePanelProps {
  message: ThreadMessage | null;
  analysis?: ParsedAnalysis | null;
  onReclassify?: () => void;
  onMarkMisclassified?: (correctType: string) => void;
  isLoading?: boolean;
}

const CLASSIFICATION_TYPES = [
  "ACKNOWLEDGMENT",
  "FEE_QUOTE",
  "DENIAL",
  "PARTIAL_DENIAL",
  "RECORDS_PROVIDED",
  "CLARIFICATION_REQUEST",
  "EXTENSION_NOTICE",
  "PORTAL_INSTRUCTION",
  "NO_RECORDS",
  "OTHER",
];

const CLASSIFICATION_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  ACKNOWLEDGMENT: { color: "bg-blue-100 text-blue-800", icon: <Mail className="h-3 w-3" /> },
  FEE_QUOTE: { color: "bg-amber-100 text-amber-800", icon: <DollarSign className="h-3 w-3" /> },
  DENIAL: { color: "bg-red-100 text-red-800", icon: <AlertTriangle className="h-3 w-3" /> },
  PARTIAL_DENIAL: { color: "bg-orange-100 text-orange-800", icon: <AlertTriangle className="h-3 w-3" /> },
  RECORDS_PROVIDED: { color: "bg-green-100 text-green-800", icon: <FileText className="h-3 w-3" /> },
  CLARIFICATION_REQUEST: { color: "bg-purple-100 text-purple-800", icon: <Mail className="h-3 w-3" /> },
  EXTENSION_NOTICE: { color: "bg-yellow-100 text-yellow-800", icon: <Clock className="h-3 w-3" /> },
  PORTAL_INSTRUCTION: { color: "bg-cyan-100 text-cyan-800", icon: <ExternalLink className="h-3 w-3" /> },
  NO_RECORDS: { color: "bg-gray-100 text-gray-800", icon: <FileText className="h-3 w-3" /> },
  OTHER: { color: "bg-gray-100 text-gray-800", icon: <Mail className="h-3 w-3" /> },
};

export function InboundEvidencePanel({
  message,
  analysis,
  onReclassify,
  onMarkMisclassified,
  isLoading,
}: InboundEvidencePanelProps) {
  const [showFullBody, setShowFullBody] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  if (!message) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Inbound Evidence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No inbound message to display
          </p>
        </CardContent>
      </Card>
    );
  }

  const classification = analysis?.classification;
  const classConfig = classification?.type
    ? CLASSIFICATION_CONFIG[classification.type] || CLASSIFICATION_CONFIG.OTHER
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Inbound Evidence
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Classification badge */}
            {classification && classConfig && (
              <Badge className={cn("gap-1", classConfig.color)}>
                {classConfig.icon}
                {classification.type}
                <span className="opacity-70">
                  ({Math.round(classification.confidence * 100)}%)
                </span>
              </Badge>
            )}
            {/* Actions dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onReclassify} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Re-run classification
                </DropdownMenuItem>
                {CLASSIFICATION_TYPES.map((type) => (
                  <DropdownMenuItem
                    key={type}
                    onClick={() => onMarkMisclassified?.(type)}
                    disabled={isLoading || type === classification?.type}
                  >
                    <Flag className="h-4 w-4 mr-2" />
                    Mark as {type}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Message Header */}
        <div className="bg-muted/50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">From:</span>
            <span className="font-medium">{message.from_email}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Date:</span>
            <span>{formatDate(message.sent_at || message.timestamp)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Subject:</span>
            <span className="font-medium">{message.subject || "(No subject)"}</span>
          </div>
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Attachments:</span>
              <div className="flex flex-wrap gap-1">
                {message.attachments.map((att, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {att.filename || `Attachment ${i + 1}`}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Message Body */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Message Body</p>
            <div className="flex gap-1">
              <Button
                variant={showRaw ? "outline" : "default"}
                size="sm"
                className="h-6 text-xs"
                onClick={() => setShowRaw(false)}
              >
                Clean
              </Button>
              {message.raw_body && (
                <Button
                  variant={showRaw ? "default" : "outline"}
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setShowRaw(true)}
                >
                  Raw
                </Button>
              )}
            </div>
          </div>
          <Collapsible open={showFullBody} onOpenChange={setShowFullBody}>
            <div className="bg-muted/30 rounded-lg p-3 text-sm">
              <pre className="whitespace-pre-wrap font-sans">
                {showRaw
                  ? (message.raw_body || message.body)?.slice(0, showFullBody ? undefined : 500)
                  : message.body?.slice(0, showFullBody ? undefined : 500)}
                {!showFullBody && (message.body?.length || 0) > 500 && "..."}
              </pre>
            </div>
            {(message.body?.length || 0) > 500 && (
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full mt-1 h-7 text-xs">
                  {showFullBody ? (
                    <>
                      <ChevronDown className="h-3 w-3 mr-1" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronRight className="h-3 w-3 mr-1" />
                      Show full message ({message.body?.length} chars)
                    </>
                  )}
                </Button>
              </CollapsibleTrigger>
            )}
          </Collapsible>
        </div>

        <Separator />

        {/* Parsed Fields */}
        <div>
          <p className="text-sm font-medium mb-3">Parsed Fields</p>
          <div className="grid grid-cols-2 gap-3">
            {/* Intent */}
            {analysis?.intent && (
              <div className="bg-muted/30 rounded p-2">
                <p className="text-xs text-muted-foreground">Intent</p>
                <p className="text-sm font-medium">{analysis.intent}</p>
              </div>
            )}

            {/* Fee Amount */}
            {analysis?.extracted_fee_amount !== undefined && (
              <div className="bg-amber-50 rounded p-2">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <DollarSign className="h-3 w-3" />
                  Fee Amount
                </p>
                <p className="text-sm font-medium text-amber-700">
                  ${analysis.extracted_fee_amount.toLocaleString()}
                </p>
              </div>
            )}

            {/* Due Date */}
            {analysis?.extracted_due_date && (
              <div className="bg-orange-50 rounded p-2">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Due Date
                </p>
                <p className="text-sm font-medium text-orange-700">
                  {formatDate(analysis.extracted_due_date)}
                </p>
              </div>
            )}

            {/* Sentiment */}
            {analysis?.sentiment && (
              <div className="bg-muted/30 rounded p-2">
                <p className="text-xs text-muted-foreground">Sentiment</p>
                <p className="text-sm font-medium">{analysis.sentiment}</p>
              </div>
            )}
          </div>

          {/* Detected Statutes */}
          {analysis?.detected_statutes && analysis.detected_statutes.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                <Scale className="h-3 w-3" />
                Detected Statutes/Exemptions
              </p>
              <div className="flex flex-wrap gap-1">
                {analysis.detected_statutes.map((statute, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {statute}
                  </Badge>
                ))}
                {analysis.detected_exemptions?.map((exemption, i) => (
                  <Badge key={`ex-${i}`} variant="secondary" className="text-xs text-red-600">
                    {exemption}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Portal Instructions */}
          {analysis?.portal_instructions && (
            <div className="mt-3 bg-cyan-50 border border-cyan-200 rounded p-2">
              <p className="text-xs text-cyan-700 font-medium flex items-center gap-1 mb-1">
                <ExternalLink className="h-3 w-3" />
                Portal Instructions
              </p>
              <p className="text-sm text-cyan-800">{analysis.portal_instructions}</p>
            </div>
          )}

          {/* Key Points */}
          {analysis?.key_points && analysis.key_points.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-1">Key Points</p>
              <ul className="text-sm space-y-1">
                {analysis.key_points.map((point, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Risk Flags */}
          {analysis?.risk_flags && analysis.risk_flags.length > 0 && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded p-2">
              <p className="text-xs text-red-700 font-medium flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3 w-3" />
                Risk Flags
              </p>
              <div className="flex flex-wrap gap-1">
                {analysis.risk_flags.map((flag, i) => (
                  <Badge key={i} variant="destructive" className="text-xs">
                    {flag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
