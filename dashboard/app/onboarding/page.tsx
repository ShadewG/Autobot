"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Bug,
  BookOpen,
} from "lucide-react";
import Link from "next/link";

const ONBOARDING_KEY = "autobot_onboarding_completed";

const steps = [
  {
    icon: FileText,
    title: "1. Create a Case",
    description:
      'Go to Cases and click "New Case" to start a FOIA request. Fill in the subject name, agency, state, and record types. You can also import cases directly from Notion.',
    link: "/requests",
    linkLabel: "Go to Cases",
  },
  {
    icon: Zap,
    title: "2. AI Drafts the Request",
    description:
      "The AI researches the agency, state laws, exemptions, and deadlines. It drafts a legally compliant FOIA request tailored to the jurisdiction.",
  },
  {
    icon: Eye,
    title: "3. Review Proposals",
    description:
      'Check the Queue for proposals needing your approval. You can Approve, Adjust (give instructions to redraft), or Dismiss. Edit drafts inline before sending.',
    link: "/gated",
    linkLabel: "Go to Queue",
  },
  {
    icon: Send,
    title: "4. Send & Track",
    description:
      "Approved requests are sent via email or submitted through agency web portals automatically. Track delivery status, bounces, and responses in real-time.",
  },
  {
    icon: MessageSquare,
    title: "5. Handle Responses",
    description:
      "When agencies reply, the AI analyzes the response and proposes the next action — follow-up, appeal, pay a fee, or close the case.",
  },
  {
    icon: CheckCircle2,
    title: "6. Case Resolves",
    description:
      "Cases close when records are received, the request is fulfilled, or you withdraw. Every action is logged in the audit trail.",
  },
];

const features = [
  {
    icon: Shield,
    title: "Supervised Mode",
    description:
      "Every AI decision requires your approval. Nothing sends without your explicit sign-off.",
  },
  {
    icon: Clock,
    title: "Deadline Tracking",
    description:
      "Automatic statutory deadline calculations per state. Alerts when agencies are overdue.",
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
      "Send the same request to multiple agencies at once for multi-jurisdiction investigations.",
  },
];

export default function OnboardingPage() {
  const replayOnboarding = () => {
    localStorage.removeItem(ONBOARDING_KEY);
    window.location.reload();
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Getting Started</h1>
          <p className="text-sm text-muted-foreground mt-1">
            How Autobot works, from case creation to fulfillment.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={replayOnboarding}>
          Replay Welcome Tour
        </Button>
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

      {/* Notion */}
      <div className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Notion Integration
        </h2>
        <Card className="p-4 space-y-3 text-xs text-muted-foreground">
          <p>
            Cases can be imported from Notion. The system extracts subject name,
            agency, incident details, and requested records from your Notion page
            properties.
          </p>
          <p>
            <strong>Police Department data</strong> (email, portal URL, address, phone)
            syncs from your Notion Police Departments database automatically.
          </p>
          <p>
            <Badge variant="outline" className="mr-1 text-[10px]">TIP</Badge>
            Set your <strong>Notion Assigned Name</strong> in{" "}
            <Link href="/settings" className="text-blue-400 hover:text-blue-300">Settings</Link>
            {" "}so imported cases link to your account.
          </p>
        </Card>
      </div>

      {/* Bug reporting */}
      <div className="space-y-3">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Reporting Issues
        </h2>
        <Card className="p-4 space-y-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Bug className="h-4 w-4 text-red-400" />
            <strong className="text-foreground">Bug Button</strong>
            <span>— The red bug icon in the bottom-right corner is on every page. Click it, describe the issue, and submit. It auto-captures your page and context.</span>
          </div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-yellow-400" />
            <strong className="text-foreground">Mark as Bugged</strong>
            <span>— On any case, open the &#8943; menu and select &quot;Mark as Bugged&quot; to pause and flag it for investigation.</span>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-blue-400" />
            <strong className="text-foreground">Feature Requests</strong>
            <span>— Go to{" "}
              <Link href="/feedback" className="text-blue-400 hover:text-blue-300">Feedback</Link>
              {" "}to submit ideas or browse past requests.
            </span>
          </div>
        </Card>
      </div>
    </div>
  );
}
