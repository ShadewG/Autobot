import { formatCurrency } from "@/lib/utils";
import type { CostStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CostDisplayProps {
  status: CostStatus;
  amount: number | null;
  className?: string;
}

export function CostDisplay({ status, amount, className }: CostDisplayProps) {
  if (status === "NONE" || amount === null) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }

  return (
    <span className={cn("font-medium", className)}>
      {formatCurrency(amount)}
    </span>
  );
}
