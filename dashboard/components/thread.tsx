"use client";

import { memo, useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LinkifiedText } from "@/components/linkified-text";
import type { ThreadMessage } from "@/lib/types";
import { formatDateTime, cn, cleanEmailBody } from "@/lib/utils";
import {
  Mail, Globe, Phone, Truck, FileText, FileCode, Loader2,
  Paperclip, Download, ExternalLink, ChevronDown, ChevronRight,
  Send, DollarSign, Scale, RotateCcw, Search, AlertTriangle,
  Bot,
} from "lucide-react";

// ── Message type config ─────────────────────────────────────────────────────

interface MessageStyle {
  label: string;
  icon: React.ReactNode;
  borderColor: string;
  bgColor: string;
  labelColor: string;
}

const OUTBOUND_STYLES: Record<string, MessageStyle> = {
  initial_request: {
    label: "Initial Request",
    icon: <Send className="h-3 w-3" />,
    borderColor: "border-l-blue-500",
    bgColor: "bg-blue-500/5",
    labelColor: "text-blue-400",
  },
  send_pdf_email: {
    label: "PDF Submission",
    icon: <FileText className="h-3 w-3" />,
    borderColor: "border-l-blue-500",
    bgColor: "bg-blue-500/5",
    labelColor: "text-blue-400",
  },
  reformulate_request: {
    label: "Reformulated Request",
    icon: <RotateCcw className="h-3 w-3" />,
    borderColor: "border-l-sky-500",
    bgColor: "bg-sky-500/5",
    labelColor: "text-sky-400",
  },
  negotiate_fee: {
    label: "Fee Negotiation",
    icon: <DollarSign className="h-3 w-3" />,
    borderColor: "border-l-amber-500",
    bgColor: "bg-amber-500/5",
    labelColor: "text-amber-400",
  },
  accept_fee: {
    label: "Fee Accepted",
    icon: <DollarSign className="h-3 w-3" />,
    borderColor: "border-l-green-500",
    bgColor: "bg-green-500/5",
    labelColor: "text-green-400",
  },
  decline_fee: {
    label: "Fee Declined",
    icon: <DollarSign className="h-3 w-3" />,
    borderColor: "border-l-red-500",
    bgColor: "bg-red-500/5",
    labelColor: "text-red-400",
  },
  appeal: {
    label: "Appeal",
    icon: <Scale className="h-3 w-3" />,
    borderColor: "border-l-orange-500",
    bgColor: "bg-orange-500/5",
    labelColor: "text-orange-400",
  },
  rebuttal: {
    label: "Rebuttal",
    icon: <AlertTriangle className="h-3 w-3" />,
    borderColor: "border-l-orange-500",
    bgColor: "bg-orange-500/5",
    labelColor: "text-orange-400",
  },
  followup: {
    label: "Follow-up",
    icon: <RotateCcw className="h-3 w-3" />,
    borderColor: "border-l-indigo-500",
    bgColor: "bg-indigo-500/5",
    labelColor: "text-indigo-400",
  },
  follow_up: {
    label: "Follow-up",
    icon: <RotateCcw className="h-3 w-3" />,
    borderColor: "border-l-indigo-500",
    bgColor: "bg-indigo-500/5",
    labelColor: "text-indigo-400",
  },
  clarification: {
    label: "Clarification",
    icon: <Search className="h-3 w-3" />,
    borderColor: "border-l-cyan-500",
    bgColor: "bg-cyan-500/5",
    labelColor: "text-cyan-400",
  },
  fee_waiver_request: {
    label: "Fee Waiver Request",
    icon: <DollarSign className="h-3 w-3" />,
    borderColor: "border-l-amber-500",
    bgColor: "bg-amber-500/5",
    labelColor: "text-amber-400",
  },
  other: {
    label: "Manual Entry",
    icon: <FileText className="h-3 w-3" />,
    borderColor: "border-l-gray-500",
    bgColor: "bg-muted/50",
    labelColor: "text-muted-foreground",
  },
};

const OUTBOUND_DEFAULT: MessageStyle = {
  label: "Sent",
  icon: <Mail className="h-3 w-3" />,
  borderColor: "border-l-primary",
  bgColor: "bg-primary/5",
  labelColor: "text-primary",
};

const PORTAL_STYLE: MessageStyle = {
  label: "Portal Notification",
  icon: <Globe className="h-3 w-3" />,
  borderColor: "border-l-cyan-500",
  bgColor: "bg-cyan-500/5",
  labelColor: "text-cyan-400",
};

const PORTAL_SUBMISSION_STYLE: MessageStyle = {
  label: "Portal — Action Required",
  icon: <Globe className="h-3 w-3" />,
  borderColor: "border-l-cyan-500",
  bgColor: "bg-cyan-500/8",
  labelColor: "text-cyan-400",
};

const PORTAL_STATUS_STYLE: MessageStyle = {
  label: "Portal Status Update",
  icon: <Globe className="h-3 w-3" />,
  borderColor: "border-l-teal-500",
  bgColor: "bg-teal-500/5",
  labelColor: "text-teal-400",
};

const INBOUND_DEFAULT: MessageStyle = {
  label: "Email",
  icon: <Mail className="h-3 w-3" />,
  borderColor: "border-l-amber-500",
  bgColor: "bg-muted",
  labelColor: "text-amber-400",
};

function getMessageStyle(message: ThreadMessage): MessageStyle {
  const isOutbound = message.direction === "OUTBOUND";

  // Portal messages
  if (message.channel === "PORTAL") {
    if (message.portal_notification_type === "submission_required") return PORTAL_SUBMISSION_STYLE;
    if (message.portal_notification_type === "status_update") return PORTAL_STATUS_STYLE;
    return PORTAL_STYLE;
  }

  // Outbound — style by message_type
  if (isOutbound) {
    const mt = message.message_type || "";
    return OUTBOUND_STYLES[mt] || OUTBOUND_DEFAULT;
  }

  // Inbound email
  return INBOUND_DEFAULT;
}

// ── Phone call body parser ──────────────────────────────────────────────────

function parsePhoneCallBody(body: string) {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  let outcome = "";
  let operatorNotes = "";
  let keyPoints: string[] = [];
  let followUp = "";

  for (const line of lines) {
    if (line.startsWith("Outcome:")) {
      outcome = line.replace("Outcome:", "").trim().replace(/\.$/, "");
    } else if (line.startsWith("Operator notes:")) {
      operatorNotes = line.replace("Operator notes:", "").trim();
    } else if (line.startsWith("AI key points:")) {
      keyPoints = line.replace("AI key points:", "").trim().split("|").map((s) => s.trim()).filter(Boolean);
    } else if (line.startsWith("AI recommended follow-up:")) {
      followUp = line.replace("AI recommended follow-up:", "").trim();
    }
  }

  // Fallback for manually logged phone calls that store free-form notes
  // instead of structured "Outcome/Operator notes/AI key points" lines.
  if (!outcome && !operatorNotes && keyPoints.length === 0 && !followUp) {
    operatorNotes = body.trim();
  }

  return { outcome, operatorNotes, keyPoints, followUp };
}

// ── Phone Call Bubble ───────────────────────────────────────────────────────

const PhoneCallBubble = memo(function PhoneCallBubble({ message }: { message: ThreadMessage }) {
  const [expanded, setExpanded] = useState(false);
  const parsed = parsePhoneCallBody(message.body);
  const summary = message.summary || "";
  const subjectOutcome = message.subject?.match(/—\s*(.+)$/)?.[1]?.trim() || parsed.outcome;
  const callPhone = message.call_phone?.trim() || "";
  const callContactInfo = message.call_contact_info?.trim() || "";
  const telHref = callPhone ? `tel:${callPhone.replace(/[^\d+]/g, "")}` : "";

  return (
    <div className="w-full overflow-hidden">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <Phone className="h-3 w-3 text-violet-400" />
        <span className="font-medium text-violet-400">Phone Call</span>
        {subjectOutcome && (
          <Badge variant="outline" className="text-[10px] text-violet-400 border-violet-500/30">
            {subjectOutcome}
          </Badge>
        )}
        <span>•</span>
        <span className="font-medium truncate max-w-[200px]">
          {message.from_email || "Unknown"}
        </span>
        <span>•</span>
        <span className="whitespace-nowrap">{formatDateTime(message.sent_at)}</span>
      </div>

      <div className="p-3 w-full border-l-4 border-l-violet-500 bg-violet-500/5 overflow-hidden">
        {summary && <p className="text-sm">{summary}</p>}

        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mt-2 transition-colors"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "Hide details" : "Show details"}
        </button>

        {expanded && (
          <div className="mt-2 pt-2 border-t border-border/30 space-y-2">
            {(callPhone || callContactInfo) && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Contact</p>
                {callPhone && (
                  <p className="text-xs mt-0.5">
                    Phone:{" "}
                    <a href={telHref} className="text-primary hover:underline">
                      {callPhone}
                    </a>
                  </p>
                )}
                {callContactInfo && <p className="text-xs mt-0.5">Info: {callContactInfo}</p>}
              </div>
            )}
            {parsed.operatorNotes && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Operator Notes</p>
                <p className="text-xs mt-0.5">{parsed.operatorNotes}</p>
              </div>
            )}
            {parsed.keyPoints.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Key Points</p>
                <ul className="mt-0.5 space-y-0.5">
                  {parsed.keyPoints.map((point, i) => (
                    <li key={i} className="text-xs flex items-start gap-1.5">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {parsed.followUp && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Recommended Follow-up</p>
                <p className="text-xs mt-0.5">{parsed.followUp}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Attachments ─────────────────────────────────────────────────────────────

function AttachmentList({ attachments }: { attachments: ThreadMessage["attachments"] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {attachments.map((att, i) => {
        const isPdf = att.content_type === "application/pdf" || att.filename?.toLowerCase().endsWith(".pdf");
        const isImage = att.content_type?.startsWith("image/");
        const downloadUrl = `/api/monitor/attachments/${att.id}/download`;
        const sizeLabel = att.size_bytes
          ? att.size_bytes > 1024 * 1024
            ? `${(att.size_bytes / (1024 * 1024)).toFixed(1)} MB`
            : `${Math.round(att.size_bytes / 1024)} KB`
          : null;
        const hasText = att.has_extracted_text || !!att.extracted_text;
        const isExpanded = expandedId === att.id;

        return (
          <div key={i}>
            <div className="flex items-center gap-2 rounded border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate flex-1 min-w-0">{att.filename}</span>
              {hasText && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-green-500/10 text-green-400 border-green-500/30 shrink-0">
                  {isImage ? "OCR" : "Extracted"}
                </Badge>
              )}
              {sizeLabel && <span className="text-[10px] text-muted-foreground shrink-0">{sizeLabel}</span>}
              {hasText && (
                <button
                  onClick={() => setExpandedId(isExpanded ? null : att.id)}
                  className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 shrink-0"
                >
                  <FileText className="h-3 w-3" /> {isExpanded ? "Hide" : "Text"}
                </button>
              )}
              {isPdf && (
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
                >
                  <ExternalLink className="h-3 w-3" /> View
                </a>
              )}
              <a
                href={downloadUrl}
                download={att.filename}
                className="text-[10px] text-primary hover:underline flex items-center gap-0.5 shrink-0"
              >
                <Download className="h-3 w-3" /> Download
              </a>
            </div>
            {isExpanded && att.extracted_text && (
              <div className="ml-6 mt-1 rounded border border-border/40 bg-muted/20 p-2 max-h-48 overflow-y-auto">
                <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                  {att.extracted_text}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Message Bubble ──────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: ThreadMessage;
  showRaw: boolean;
  canonicalPortalUrl?: string | null;
  canonicalAgencyName?: string | null;
}

function normalizeAgencyToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeHistoricalOutboundText(text: string, canonicalAgencyName?: string | null): string {
  if (!text || !canonicalAgencyName) return text;

  const canonicalShort = canonicalAgencyName.split(",")[0]?.trim() || canonicalAgencyName.trim();
  if (!canonicalShort) return text;

  const canonicalToken = normalizeAgencyToken(canonicalShort);
  const replaceIfStale = (candidate: string, replacement: string): string => {
    if (!candidate || normalizeAgencyToken(candidate) === canonicalToken) return candidate;
    return replacement;
  };

  return text
    .replace(
      /\bTo ([A-Z][A-Za-z'’ .()-]+?(?:Police Department|Sheriff(?:'s|’s) Office|Department|Office)) Public Records Officer\b/g,
      (_, candidate) => `To ${replaceIfStale(candidate, canonicalShort)} Public Records Officer`
    )
    .replace(
      /\bfor the ([A-Z][A-Za-z'’ .()-]+?(?:Police Department|Sheriff(?:'s|’s) Office|Department|Office))(?=[.,\n])/g,
      (_, candidate) => `for the ${replaceIfStale(candidate, canonicalShort)}`
    );
}

const MessageBubble = memo(function MessageBubble({
  message,
  showRaw,
  canonicalPortalUrl,
  canonicalAgencyName,
}: MessageBubbleProps) {
  const isOutbound = message.direction === "OUTBOUND";
  const style = getMessageStyle(message);
  const [showQuotedThread, setShowQuotedThread] = useState(false);

  const displayBody = showRaw && message.raw_body ? message.raw_body : message.body;
  const normalizedSubject = isOutbound
    ? normalizeHistoricalOutboundText(message.subject || "", canonicalAgencyName)
    : (message.subject || "");
  const rawNormalizedBody = isOutbound
    ? normalizeHistoricalOutboundText(displayBody || "", canonicalAgencyName)
    : (displayBody || "");

  // For inbound messages, strip CID refs and split quoted thread
  const { body: cleanBody, quotedThread } = !isOutbound
    ? cleanEmailBody(rawNormalizedBody)
    : { body: rawNormalizedBody, quotedThread: null };

  const hasRawVersion = message.raw_body && message.raw_body !== message.body;

  return (
    <div className="w-full overflow-hidden">
      {/* Header */}
      <div className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground mb-1",
        isOutbound ? "justify-end" : "justify-start"
      )}>
        <span className={style.labelColor}>{style.icon}</span>
        <Badge variant="outline" className={cn("text-[10px] border-current/20", style.labelColor)}>
          {style.label}
        </Badge>
        <span className="shrink-0">{isOutbound ? "To:" : "From:"}</span>
        <span className="font-medium truncate max-w-[200px]">
          {isOutbound ? (message.to_email || "Unknown") : (message.from_email || "records@agency.gov")}
        </span>
        <span>•</span>
        <span className="whitespace-nowrap">{formatDateTime(message.sent_at)}</span>
        {hasRawVersion && (
          <Badge variant="outline" className="text-[10px] ml-1">
            {showRaw ? "raw" : "clean"}
          </Badge>
        )}
      </div>

      {/* Classification, sentiment, and AI summary for inbound messages */}
      {!isOutbound && (message.classification || message.sentiment || message.summary) && (
        <div className="mt-0.5 mb-0.5 space-y-1">
          <div className="flex items-center gap-1">
            {message.classification && (
              <Badge variant="outline" className="text-[10px]">
                {message.classification}
              </Badge>
            )}
            {message.sentiment && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  message.sentiment.toUpperCase() === 'POSITIVE' && "text-green-400",
                  message.sentiment.toUpperCase() === 'NEGATIVE' && "text-red-400",
                  message.sentiment.toUpperCase() === 'HOSTILE' && "text-red-300 bg-red-500/10"
                )}
              >
                {message.sentiment}
              </Badge>
            )}
          </div>
          {message.summary && (
            <p className="text-[11px] text-muted-foreground italic pl-1 border-l-2 border-muted">
              {message.summary}
            </p>
          )}
        </div>
      )}

      {/* Message bubble */}
      <div className={cn("p-3 w-full border-l-4 overflow-hidden", style.borderColor, style.bgColor)}>
        <p className="text-xs font-semibold mb-1.5">{normalizedSubject}</p>
        <LinkifiedText
          text={cleanBody}
          fallbackUrlForTrackedLinks={canonicalPortalUrl}
          className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        />
        {quotedThread && (
          <div className="mt-2 border-t border-border/30 pt-2">
            <button
              onClick={() => setShowQuotedThread(!showQuotedThread)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors select-none"
            >
              {showQuotedThread ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {showQuotedThread ? "Hide full thread" : "Show full thread"}
            </button>
            {showQuotedThread && (
              <div className="mt-1.5 pl-2 border-l-2 border-muted">
                <LinkifiedText
                  text={quotedThread}
                  fallbackUrlForTrackedLinks={canonicalPortalUrl}
                  className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted-foreground/60"
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sending indicator for optimistic messages */}
      {(message as any)._sending && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-1 animate-pulse">
          <Loader2 className="h-3 w-3 animate-spin" />
          Sending...
        </div>
      )}

      <AttachmentList attachments={message.attachments} />
    </div>
  );
});

// ── Thread ───────────────────────────────────────────────────────────────────

interface ThreadProps {
  messages: ThreadMessage[];
  maxHeight?: string;
  canonicalPortalUrl?: string | null;
  canonicalAgencyName?: string | null;
}

const STORAGE_KEY = 'email-view-mode';

export function Thread({ messages, maxHeight, canonicalPortalUrl, canonicalAgencyName }: ThreadProps) {
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'raw') {
      setShowRaw(true);
    }
  }, []);

  const handleToggle = (raw: boolean) => {
    setShowRaw(raw);
    localStorage.setItem(STORAGE_KEY, raw ? 'raw' : 'clean');
  };

  const hasAnyRawContent = messages.some(
    (m) => m.raw_body && m.raw_body !== m.body
  );

  if (messages.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No messages yet
      </div>
    );
  }

  const isFullHeight = maxHeight === "h-full";

  return (
    <div className={cn(isFullHeight ? "flex flex-col h-full" : "space-y-2")}>
      {hasAnyRawContent && (
        <div className={cn("flex items-center gap-1 justify-end", isFullHeight && "shrink-0 px-2 pt-1")}>
          <Button
            size="sm"
            variant={showRaw ? "ghost" : "secondary"}
            onClick={() => handleToggle(false)}
            className="h-6 text-xs px-2"
          >
            <FileText className="h-3 w-3 mr-1" />
            Clean
          </Button>
          <Button
            size="sm"
            variant={showRaw ? "secondary" : "ghost"}
            onClick={() => handleToggle(true)}
            className="h-6 text-xs px-2"
          >
            <FileCode className="h-3 w-3 mr-1" />
            Raw
          </Button>
        </div>
      )}
      <ScrollArea className={cn(isFullHeight ? "flex-1 min-h-0" : (maxHeight || "h-[400px]"), "w-full")}>
        <div className="space-y-4 pr-2 w-full">
          {[...messages].reverse().map((message) => (
            message.channel === "CALL"
              ? <PhoneCallBubble key={message.id} message={message} />
              : (
                <MessageBubble
                  key={message.id}
                  message={message}
                  showRaw={showRaw}
                  canonicalPortalUrl={canonicalPortalUrl}
                  canonicalAgencyName={canonicalAgencyName}
                />
              )
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
