"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { Constraint, ExemptionInfo } from "@/lib/types";
import { STATE_EXEMPTIONS } from "@/lib/state-exemptions";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Search,
  CheckCircle,
  Gavel,
  Loader2,
  ExternalLink,
} from "lucide-react";

interface ExemptionClaimCardProps {
  constraint: Constraint;
  constraintIndex: number;
  state: string;
  requestId: string;
  onChallenge?: (instruction: string) => void;
  onAccept?: () => void;
  className?: string;
}

export function ExemptionClaimCard({
  constraint,
  constraintIndex,
  state,
  requestId,
  onChallenge,
  onAccept,
  className,
}: ExemptionClaimCardProps) {
  const [isResearching, setIsResearching] = useState(false);
  const [researchResults, setResearchResults] = useState<string | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  // Find relevant state exemption info
  const stateExemptions = STATE_EXEMPTIONS[state] || [];
  const matchingExemption = stateExemptions.find((ex) =>
    constraint.source?.includes(ex.statute) ||
    constraint.description?.toLowerCase().includes(ex.title.toLowerCase())
  );

  const handleResearch = async () => {
    setIsResearching(true);
    setResearchError(null);
    try {
      const response = await fetch(`/api/requests/${requestId}/research-exemption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ constraint_index: constraintIndex }),
      });

      if (!response.ok) {
        throw new Error('Research request failed');
      }

      const data = await response.json();
      setResearchResults(data.research?.content || 'No results found');
    } catch (error) {
      setResearchError('Failed to research exemption. Please try again.');
      console.error('Research error:', error);
    } finally {
      setIsResearching(false);
    }
  };

  const handleChallenge = () => {
    const instruction = `Challenge the exemption claim: "${constraint.description}".
The agency cited ${constraint.source || 'exemption'} as the basis for withholding ${constraint.affected_items.join(', ')}.
${matchingExemption ? `Known exceptions to this exemption include: ${matchingExemption.exceptions.join(', ')}.` : ''}
Draft a response that respectfully challenges this exemption and requests the records be released or that the agency provide more specific justification.`;

    onChallenge?.(instruction);
  };

  return (
    <Card className={cn("border-amber-700/50 bg-amber-500/10/50", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          Agency Claims Exemption
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* The claim */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Claim:</p>
          <p className="text-sm">&ldquo;{constraint.description}&rdquo;</p>
          {constraint.source && (
            <p className="text-xs text-muted-foreground">Source: {constraint.source}</p>
          )}
        </div>

        {/* Affected items */}
        {constraint.affected_items && constraint.affected_items.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Affects:</p>
            <div className="flex flex-wrap gap-1">
              {constraint.affected_items.map((item, i) => (
                <Badge key={i} variant="outline" className="text-xs bg-red-500/10 text-red-300 border-red-700/50">
                  {item}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* State law reference */}
        {matchingExemption && (
          <>
            <Separator className="my-2" />
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {state} Law Reference:
              </p>
              <div className="bg-white/80 border rounded p-2">
                <p className="text-xs font-medium">{matchingExemption.statute}</p>
                <p className="text-xs text-muted-foreground">{matchingExemption.title}</p>
                {matchingExemption.exceptions.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-green-300">Known Exceptions:</p>
                    <ul className="text-xs text-muted-foreground list-disc list-inside">
                      {matchingExemption.exceptions.map((ex, i) => (
                        <li key={i}>{ex}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Research results */}
        {researchResults && (
          <>
            <Separator className="my-2" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                <Search className="h-3 w-3" />
                Research Results:
              </p>
              <div className="bg-white/80 border rounded p-2 max-h-48 overflow-y-auto">
                <p className="text-xs whitespace-pre-wrap">{researchResults}</p>
              </div>
            </div>
          </>
        )}

        {/* Error */}
        {researchError && (
          <p className="text-xs text-red-400">{researchError}</p>
        )}

        {/* Action buttons */}
        <Separator className="my-2" />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={handleChallenge}
            className="text-xs"
          >
            <Gavel className="h-3 w-3 mr-1" />
            Challenge
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onAccept}
            className="text-xs"
          >
            <CheckCircle className="h-3 w-3 mr-1" />
            Accept & Proceed
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleResearch}
            disabled={isResearching}
            className="text-xs"
          >
            {isResearching ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Search className="h-3 w-3 mr-1" />
            )}
            Research Claim
          </Button>
        </div>

        {/* Confidence indicator */}
        {constraint.confidence !== undefined && constraint.confidence < 1 && (
          <p className="text-[10px] text-muted-foreground">
            Exemption detection confidence: {Math.round(constraint.confidence * 100)}%
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// List of all exemption claims for a request
interface ExemptionClaimsListProps {
  constraints: Constraint[];
  state: string;
  requestId: string;
  onChallenge?: (instruction: string) => void;
  onAccept?: () => void;
}

export function ExemptionClaimsList({
  constraints,
  state,
  requestId,
  onChallenge,
  onAccept,
}: ExemptionClaimsListProps) {
  // Filter to only exemption constraints
  const exemptionConstraints = constraints.filter(c => c.type === 'EXEMPTION');

  if (exemptionConstraints.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {exemptionConstraints.map((constraint, index) => (
        <ExemptionClaimCard
          key={index}
          constraint={constraint}
          constraintIndex={index}
          state={state}
          requestId={requestId}
          onChallenge={onChallenge}
          onAccept={onAccept}
        />
      ))}
    </div>
  );
}
