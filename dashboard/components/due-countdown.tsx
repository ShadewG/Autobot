import { formatDueCountdown } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface DueCountdownProps {
  dueAt: string | null;
  className?: string;
}

export function DueCountdown({ dueAt, className }: DueCountdownProps) {
  if (!dueAt) {
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  }

  const countdown = formatDueCountdown(dueAt);
  const isOverdue = countdown.includes("overdue");
  const isUrgent = !isOverdue && parseInt(countdown) <= 2;

  return (
    <span
      className={cn(
        "font-medium",
        isOverdue && "text-destructive",
        isUrgent && !isOverdue && "text-yellow-600 dark:text-yellow-500",
        !isOverdue && !isUrgent && "text-muted-foreground",
        className
      )}
    >
      {countdown}
    </span>
  );
}
