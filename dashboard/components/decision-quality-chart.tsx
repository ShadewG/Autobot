"use client";

import useSWR from "swr";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetcher } from "@/lib/api";
import { Loader2, TrendingUp } from "lucide-react";

interface TrendPoint {
  date: string;
  total_reviews: number;
  approve_count: number;
  adjust_count: number;
  dismiss_count: number;
  approval_rate: number | null;
  adjust_rate: number | null;
  dismiss_rate: number | null;
}

interface TrendResponse {
  success: boolean;
  days: number;
  trend: TrendPoint[];
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatPercent(value: number | null) {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function DecisionQualityChart() {
  const { data, isLoading } = useSWR<TrendResponse>(
    "/eval/decision-quality-trend?days=30",
    fetcher,
    { refreshInterval: 60000 }
  );

  const trend = data?.trend || [];

  const chartData = trend.map((p) => ({
    date: formatDate(p.date),
    "Approval %": p.approval_rate != null ? Math.round(p.approval_rate * 100) : null,
    "Adjust %": p.adjust_rate != null ? Math.round(p.adjust_rate * 100) : null,
    "Dismiss %": p.dismiss_rate != null ? Math.round(p.dismiss_rate * 100) : null,
    total: p.total_reviews,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Decision Quality Over Time
          <span className="text-xs text-muted-foreground font-normal ml-1">(30d)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <TrendingUp className="h-6 w-6 mb-2 opacity-30" />
            <p className="text-xs">No decision data yet</p>
          </div>
        ) : (
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, name: any) => [`${value}%`, name]}
                  labelFormatter={(label) => label}
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px" }}
                  iconType="line"
                />
                <Line
                  type="monotone"
                  dataKey="Approval %"
                  stroke="#4ade80"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#4ade80" }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="Adjust %"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#fbbf24" }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="Dismiss %"
                  stroke="#f87171"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#f87171" }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
