"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Send,
  Eye,
  MessageSquare,
  CheckCircle2,
  Zap,
  Globe,
  Bug,
  BookOpen,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";

const ONBOARDING_KEY = "autobot_onboarding_completed";

const slides = [
  {
    title: "Welcome to Autobot",
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Autobot automates FOIA requests from drafting to fulfillment. The AI
          handles research, drafting, sending, and follow-ups — you stay in
          control by reviewing every proposal before it goes out.
        </p>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-400 shrink-0" />
            <span><strong>Supervised Mode</strong> — nothing sends without your approval</span>
          </div>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-blue-400 shrink-0" />
            <span><strong>Portal + Email</strong> — supports both email and web portal submissions</span>
          </div>
          <div className="flex items-center gap-2">
            <Bug className="h-4 w-4 text-red-400 shrink-0" />
            <span><strong>Bug Button</strong> — see a floating bug icon? Click it anytime to report issues</span>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: "How It Works",
    content: (
      <div className="space-y-2">
        {[
          { icon: FileText, label: "Create a case", desc: "Add subject, agency, state, and record types. Or import from Notion." },
          { icon: Zap, label: "AI drafts the request", desc: "Researches state laws, exemptions, and deadlines. Writes a legally compliant FOIA letter." },
          { icon: Eye, label: "You review proposals", desc: "Check the Queue. Approve, Adjust, or Dismiss. Edit drafts inline before sending." },
          { icon: Send, label: "Request is sent", desc: "Via email or portal submission — tracked automatically with delivery status." },
          { icon: MessageSquare, label: "AI handles responses", desc: "Analyzes agency replies. Proposes follow-ups, appeals, fee payments, or closures." },
          { icon: CheckCircle2, label: "Case resolves", desc: "Records received, fulfilled, or withdrawn. Full audit trail preserved." },
        ].map((step, i) => (
          <div key={i} className="flex items-start gap-3 text-xs rounded-md border p-2.5">
            <step.icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <span className="font-medium text-foreground">{step.label}</span>
              <span className="text-muted-foreground ml-1">— {step.desc}</span>
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    title: "Notion Integration",
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          Cases can be imported directly from your Notion workspace. The system
          pulls case details, subject info, and agency contacts automatically.
        </p>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <p><strong>To import a case:</strong></p>
          <ol className="list-decimal ml-4 space-y-1">
            <li>Copy the Notion page URL for your case</li>
            <li>In Cases, click &quot;Import from Notion&quot; and paste the URL</li>
            <li>The system extracts subject name, agency, records needed, and incident details</li>
            <li>Police department contacts are pulled from the linked department page</li>
          </ol>
        </div>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <p><strong>Agency directory sync:</strong></p>
          <p>Police department info (email, portal URL, address, phone) syncs from your Notion Police Departments database. Changes in Notion propagate automatically.</p>
        </div>
        <div className="rounded-md border p-3 text-xs">
          <p><strong>Setup:</strong> Go to <strong>Settings</strong> and set your <strong>Notion Assigned Name</strong> so imported cases are linked to your account.</p>
        </div>
      </div>
    ),
  },
  {
    title: "Reporting Issues",
    content: (
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          See something wrong? There are two quick ways to report it:
        </p>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2 mb-2">
            <Bug className="h-4 w-4 text-red-400" />
            <strong className="text-foreground">Floating Bug Button</strong>
          </div>
          <p>
            The <strong>red bug icon</strong> in the bottom-right corner is always
            available on every page. Click it, type what went wrong, and submit.
            It automatically captures which page you&apos;re on and your user context.
          </p>
        </div>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="h-4 w-4 text-yellow-400" />
            <strong className="text-foreground">Mark Case as Bugged</strong>
          </div>
          <p>
            On any case detail page, open the <strong>&#8943; menu</strong> and
            select <strong>&quot;Mark as Bugged&quot;</strong>. This pauses the
            case and flags it for the team to investigate. Describe what looks
            wrong and we&apos;ll fix it.
          </p>
        </div>
        <div className="rounded-md border p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-4 w-4 text-blue-400" />
            <strong className="text-foreground">Feature Requests</strong>
          </div>
          <p>
            Go to <strong>Feedback</strong> in the nav bar to submit feature
            requests or browse past submissions.
          </p>
        </div>
      </div>
    ),
  },
];

export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const completed = localStorage.getItem(ONBOARDING_KEY);
    if (!completed) {
      setOpen(true);
    }
  }, []);

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, new Date().toISOString());
    setOpen(false);
  };

  const isLast = step === slides.length - 1;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleComplete(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{slides[step].title}</DialogTitle>
          <div className="flex gap-1 pt-1">
            {slides.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= step ? "bg-foreground" : "bg-muted"
                }`}
              />
            ))}
          </div>
        </DialogHeader>

        <div className="py-2">{slides[step].content}</div>

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0}
            className="gap-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </Button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleComplete}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip
            </button>
            {isLast ? (
              <Button size="sm" onClick={handleComplete}>
                Get Started
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => setStep((s) => s + 1)}
                className="gap-1"
              >
                Next <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
