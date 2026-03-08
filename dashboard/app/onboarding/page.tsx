"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Send,
  Eye,
  MessageSquare,
  CheckCircle2,
  ArrowRight,
  Zap,
  Shield,
  Clock,
  Globe,
} from "lucide-react";
import Link from "next/link";

const steps = [
  {
    icon: FileText,
    title: "1. Create a Case",
    description:
      'Go to Cases and click "New Case" to start a FOIA request. Fill in the subject name, agency, state, and record types you need.',
    link: "/requests",
    linkLabel: "Go to Cases",
  },
  {
    icon: Zap,
    title: "2. Generate the Request",
    description:
      "The AI drafts a legally compliant FOIA request tailored to the agency and state laws. It researches exemptions, statutes, and deadlines automatically.",
  },
  {
    icon: Eye,
    title: "3. Review Proposals",
    description:
      'Check the Queue for proposals needing your approval. You can Approve, Adjust (edit instructions), or Dismiss any proposal. The AI explains its reasoning.',
    link: "/gated",
    linkLabel: "Go to Queue",
  },
  {
    icon: Send,
    title: "4. Send & Track",
    description:
      "Once approved, requests are sent via email or submitted through agency portals automatically. Track delivery status and responses in real-time.",
  },
  {
    icon: MessageSquare,
    title: "5. Handle Responses",
    description:
      "When agencies reply, the AI analyzes their response and proposes the next action — follow-up, appeal a denial, pay a fee, or close the case.",
  },
  {
    icon: CheckCircle2,
    title: "6. Close the Loop",
    description:
      "Cases resolve when records are received, the request is fulfilled, or you decide to withdraw. Every action is logged for your audit trail.",
  },
];

const features = [
  {
    icon: Shield,
    title: "Supervised Mode",
    description:
      "Every AI decision requires your approval. Nothing is sent without your explicit sign-off.",
  },
  {
    icon: Clock,
    title: "Deadline Tracking",
    description:
      "Automatic statutory deadline calculations per state. Get alerted when agencies are overdue.",
  },
  {
    icon: Globe,
    title: "Portal Submissions",
    description:
      "Agencies with online portals get submissions filed automatically via browser automation.",
  },
  {
    icon: Zap,
    title: "Batch Operations",
    description:
      "Send the same request to multiple agencies at once. Great for multi-jurisdiction investigations.",
  },
];

export default function OnboardingPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-8 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Getting Started</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Autobot automates FOIA requests from drafting to fulfillment. Here&apos;s how it works.
        </p>
      </div>

      {/* Workflow steps */}
      <div className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Workflow
        </h2>
        {steps.map((step, i) => (
          <Card key={i} className="p-4">
            <div className="flex gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <step.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">{step.title}</div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {step.description}
                </p>
                {step.link && (
                  <Link
                    href={step.link}
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-2"
                  >
                    {step.linkLabel} <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Key features */}
      <div className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Key Features
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {features.map((f, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-3">
                <f.icon className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-sm font-medium">{f.title}</div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {f.description}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Quick tips */}
      <div className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Tips
        </h2>
        <Card className="p-4 space-y-2 text-xs text-muted-foreground">
          <p>
            <Badge variant="outline" className="mr-2 text-[10px]">TIP</Badge>
            Use <strong>Adjust</strong> to refine AI drafts before sending — add specific record numbers, date ranges, or special instructions.
          </p>
          <p>
            <Badge variant="outline" className="mr-2 text-[10px]">TIP</Badge>
            Set your email signature in{" "}
            <Link href="/settings" className="text-blue-400 hover:text-blue-300">Settings</Link>
            {" "}so requests include your contact information.
          </p>
          <p>
            <Badge variant="outline" className="mr-2 text-[10px]">TIP</Badge>
            If something looks wrong with a case, use the <strong>Mark as Bugged</strong> option in the case menu — we&apos;ll investigate.
          </p>
          <p>
            <Badge variant="outline" className="mr-2 text-[10px]">TIP</Badge>
            Check{" "}
            <Link href="/analytics" className="text-blue-400 hover:text-blue-300">Analytics</Link>
            {" "}for response rate trends and agency performance data.
          </p>
        </Card>
      </div>
    </div>
  );
}
