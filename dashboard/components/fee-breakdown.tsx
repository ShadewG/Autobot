"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { FeeQuote, FeeBreakdownItem, ScopeItem } from "@/lib/types";
import { formatCurrency, cn } from "@/lib/utils";
import { DollarSign, CheckCircle, XCircle, FileX } from "lucide-react";

// Category labels for fee breakdown
const CATEGORY_LABELS: Record<string, string> = {
  SEARCH: 'Search',
  REVIEW: 'Review',
  DUPLICATION: 'Duplication',
  MEDIA: 'Media',
  OTHER: 'Other',
};

interface FeeBreakdownProps {
  feeQuote: FeeQuote;
  scopeItems?: ScopeItem[];
  className?: string;
}

export function FeeBreakdown({ feeQuote, scopeItems, className }: FeeBreakdownProps) {
  if (!feeQuote || !feeQuote.amount) {
    return null;
  }

  const depositAmount = feeQuote.deposit_amount || 0;
  const balanceDue = feeQuote.amount - depositAmount;

  // Separate scope items by availability
  const coveredItems = scopeItems?.filter(
    i => i.status === 'CONFIRMED_AVAILABLE'
  ) || [];
  const notCoveredItems = scopeItems?.filter(
    i => i.status === 'NOT_DISCLOSABLE' || i.status === 'NOT_HELD'
  ) || [];

  // Format breakdown line item
  const formatLineItem = (item: FeeBreakdownItem): string => {
    if (item.unit_type === 'HOUR' && item.quantity && item.unit_rate) {
      return `${item.quantity} hrs @ ${formatCurrency(item.unit_rate)}/hr`;
    }
    if (item.unit_type === 'PAGE' && item.quantity) {
      return `${item.quantity} pages`;
    }
    if (item.description) {
      return item.description;
    }
    return item.item;
  };

  return (
    <Card className={cn("border-amber-200 bg-amber-50/50", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
          <DollarSign className="h-4 w-4" />
          Fee Estimate: {formatCurrency(feeQuote.amount)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Breakdown items */}
        {feeQuote.breakdown && feeQuote.breakdown.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Breakdown:</p>
            <div className="space-y-0.5">
              {feeQuote.breakdown.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {item.category ? `${CATEGORY_LABELS[item.category] || item.category}: ` : ''}
                    {formatLineItem(item)}
                  </span>
                  <span className="font-medium">{formatCurrency(item.subtotal)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Rate summary if no breakdown but has hourly info */}
        {(!feeQuote.breakdown || feeQuote.breakdown.length === 0) &&
         feeQuote.hourly_rate && feeQuote.estimated_hours && (
          <div className="text-xs text-muted-foreground">
            {feeQuote.estimated_hours} hours @ {formatCurrency(feeQuote.hourly_rate)}/hr
          </div>
        )}

        {/* Deposit and balance */}
        {depositAmount > 0 && (
          <>
            <Separator className="my-2" />
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">Deposit Required:</span>
                <span className="font-semibold text-amber-700">
                  {formatCurrency(depositAmount)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Balance Due:</span>
                <span>{formatCurrency(balanceDue)}</span>
              </div>
            </div>
          </>
        )}

        {/* Covered items */}
        {coveredItems.length > 0 && (
          <>
            <Separator className="my-2" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Covers:</p>
              <div className="space-y-0.5">
                {coveredItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-green-700">
                    <CheckCircle className="h-3 w-3" />
                    {item.name}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Not covered items */}
        {notCoveredItems.length > 0 && (
          <>
            <Separator className="my-2" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">NOT Covered:</p>
              <div className="space-y-0.5">
                {notCoveredItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    {item.status === 'NOT_DISCLOSABLE' ? (
                      <>
                        <XCircle className="h-3 w-3 text-red-600" />
                        <span className="text-red-700">{item.name}</span>
                        <span className="text-muted-foreground">(exempt)</span>
                      </>
                    ) : (
                      <>
                        <FileX className="h-3 w-3 text-orange-600" />
                        <span className="text-orange-700">{item.name}</span>
                        <span className="text-muted-foreground">(not held)</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Notes */}
        {feeQuote.notes && (
          <>
            <Separator className="my-2" />
            <p className="text-xs text-muted-foreground italic">{feeQuote.notes}</p>
          </>
        )}

        {/* Waiver possibility */}
        {feeQuote.waiver_possible && (
          <p className="text-xs text-blue-600 font-medium">
            Fee waiver may be possible
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Compact fee summary for inline display
interface FeeSummaryProps {
  feeQuote: FeeQuote;
}

export function FeeSummary({ feeQuote }: FeeSummaryProps) {
  if (!feeQuote || !feeQuote.amount) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <DollarSign className="h-4 w-4 text-amber-600" />
      <span className="font-semibold">{formatCurrency(feeQuote.amount)}</span>
      {feeQuote.deposit_amount && feeQuote.deposit_amount > 0 && (
        <span className="text-xs text-muted-foreground">
          ({formatCurrency(feeQuote.deposit_amount)} deposit)
        </span>
      )}
    </div>
  );
}
