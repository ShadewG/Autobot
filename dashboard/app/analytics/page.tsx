"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetcher } from "@/lib/api";
import { Loader2 } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";

interface CostsResponse {
  success: boolean;
  total_estimated_cost: number;
  by_model: Array<{
    model: string;
    step: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost: number;
  }>;
  top_cases: Array<{
    case_id: number;
    case_name: string;
    agency_name: string;
    input_tokens: number;
    output_tokens: number;
    estimated_cost: number;
  }>;
}

interface OutcomesResponse {
  success: boolean;
  overall: {
    total_cases: string;
    completed: string;
    active: string;
    awaiting_response: string;
    completion_rate: string | null;
    avg_response_days: string | null;
    avg_case_duration_days: string | null;
  };
  byState: Array<{
    state: string;
    total: string;
    completed: string;
    awaiting: string;
    avg_response_days: string | null;
    denials: string;
  }>;
  denialReasons: Array<{ reason: string; count: string }>;
  statusBreakdown: Array<{ status: string; count: string }>;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#4ade80",
  sent: "#60a5fa",
  responded: "#fbbf24",
  ready_to_send: "#a78bfa",
  draft: "#94a3b8",
  closed: "#6b7280",
  error: "#f87171",
};

const DENIAL_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a78bfa", "#60a5fa", "#34d399", "#94a3b8",
];

function formatDenialReason(reason: string): string {
  return reason
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AnalyticsPage() {
  const { data, error, isLoading } = useSWR<OutcomesResponse>(
    "/dashboard/outcomes",
    fetcher,
    { refreshInterval: 60000 }
  );

  const { data: costData } = useSWR<CostsResponse>(
    "/dashboard/costs",
    fetcher,
    { refreshInterval: 120000 }
  );

  const { statusData, stateData, denialData, kpis } = useMemo(() => {
    if (!data?.overall)
      return { statusData: [], stateData: [], denialData: [], kpis: null };

    const o = data.overall;
    const total = Number(o.total_cases) || 0;
    const completed = Number(o.completed) || 0;
    const denialTotal = data.denialReasons.reduce(
      (sum, d) => sum + Number(d.count),
      0
    );

    return {
      kpis: {
        totalCases: total,
        completionRate: o.completion_rate ? Number(o.completion_rate) : 0,
        avgResponseDays: o.avg_response_days ? Number(o.avg_response_days) : null,
        avgCaseDuration: o.avg_case_duration_days
          ? Number(o.avg_case_duration_days)
          : null,
        denialRate:
          total > 0 ? Math.round((denialTotal / total) * 100) : 0,
        awaitingResponse: Number(o.awaiting_response) || 0,
        completed,
      },
      statusData: data.statusBreakdown.map((s) => ({
        name: s.status.replace(/_/g, " "),
        value: Number(s.count),
        color: STATUS_COLORS[s.status] || "#94a3b8",
      })),
      stateData: data.byState.slice(0, 15).map((s) => ({
        state: s.state,
        total: Number(s.total),
        completed: Number(s.completed),
        awaiting: Number(s.awaiting),
        denials: Number(s.denials),
        avgDays: s.avg_response_days ? Number(s.avg_response_days) : null,
      })),
      denialData: data.denialReasons.map((d) => ({
        name: formatDenialReason(d.reason),
        value: Number(d.count),
      })),
    };
  }, [data]);

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load analytics</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  if (isLoading || !kpis) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Case Outcomes</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <KPICard label="Total Cases" value={kpis.totalCases} />
        <KPICard label="Completed" value={kpis.completed} accent="green" />
        <KPICard
          label="Completion Rate"
          value={`${kpis.completionRate}%`}
          accent="green"
        />
        <KPICard
          label="Avg Response"
          value={kpis.avgResponseDays != null ? `${kpis.avgResponseDays}d` : "N/A"}
        />
        <KPICard
          label="Denial Rate"
          value={`${kpis.denialRate}%`}
          accent={kpis.denialRate > 40 ? "red" : undefined}
        />
        <KPICard label="Awaiting" value={kpis.awaitingResponse} accent="amber" />
      </div>

      {/* Charts Row */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Status Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Case Status Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={statusData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                    label={({ name, value }: any) => `${name} (${value})`}
                  >
                    {statusData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No data
              </p>
            )}
          </CardContent>
        </Card>

        {/* Denial Reasons */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Denial Reasons</CardTitle>
          </CardHeader>
          <CardContent>
            {denialData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={denialData}
                  layout="vertical"
                  margin={{ left: 100, right: 16, top: 8, bottom: 8 }}
                >
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    width={95}
                  />
                  <Tooltip />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {denialData.map((_, i) => (
                      <Cell
                        key={i}
                        fill={DENIAL_COLORS[i % DENIAL_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No denials recorded
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* By State */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Outcomes by State</CardTitle>
        </CardHeader>
        <CardContent>
          {stateData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart
                data={stateData}
                margin={{ left: 0, right: 16, top: 8, bottom: 8 }}
              >
                <XAxis dataKey="state" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(value: any, name: any) => [
                    value,
                    String(name).charAt(0).toUpperCase() + String(name).slice(1),
                  ]}
                />
                <Bar
                  dataKey="completed"
                  stackId="a"
                  fill="#4ade80"
                  radius={[0, 0, 0, 0]}
                  name="Completed"
                />
                <Bar
                  dataKey="awaiting"
                  stackId="a"
                  fill="#60a5fa"
                  radius={[0, 0, 0, 0]}
                  name="Awaiting"
                />
                <Bar
                  dataKey="denials"
                  stackId="a"
                  fill="#f87171"
                  radius={[4, 4, 0, 0]}
                  name="Denials"
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No state data
            </p>
          )}
        </CardContent>
      </Card>

      {/* State detail table */}
      {stateData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">State Detail</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left py-2 px-2">State</th>
                  <th className="text-right py-2 px-2">Total</th>
                  <th className="text-right py-2 px-2">Completed</th>
                  <th className="text-right py-2 px-2">Awaiting</th>
                  <th className="text-right py-2 px-2">Denials</th>
                  <th className="text-right py-2 px-2">Avg Response</th>
                </tr>
              </thead>
              <tbody>
                {stateData.map((s) => (
                  <tr key={s.state} className="border-b border-border/50">
                    <td className="py-1.5 px-2 font-medium">{s.state}</td>
                    <td className="text-right py-1.5 px-2">{s.total}</td>
                    <td className="text-right py-1.5 px-2 text-green-400">
                      {s.completed}
                    </td>
                    <td className="text-right py-1.5 px-2 text-blue-400">
                      {s.awaiting}
                    </td>
                    <td className="text-right py-1.5 px-2 text-red-400">
                      {s.denials}
                    </td>
                    <td className="text-right py-1.5 px-2">
                      {s.avgDays != null ? `${s.avgDays}d` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      {/* Cost Tracking */}
      {costData?.success && (
        <>
          <h2 className="text-lg font-semibold mt-4">AI Cost Tracking</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <KPICard
              label="Total AI Cost"
              value={`$${costData.total_estimated_cost.toFixed(2)}`}
            />
            <KPICard
              label="Total Calls"
              value={costData.by_model.reduce((s, m) => s + m.calls, 0)}
            />
            <KPICard
              label="Avg Cost/Case"
              value={
                costData.top_cases.length > 0
                  ? `$${(costData.top_cases.reduce((s, c) => s + c.estimated_cost, 0) / costData.top_cases.length).toFixed(2)}`
                  : "N/A"
              }
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Cost by model */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Cost by Model + Step</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-2">Model</th>
                      <th className="text-left py-2 px-2">Step</th>
                      <th className="text-right py-2 px-2">Calls</th>
                      <th className="text-right py-2 px-2">Tokens</th>
                      <th className="text-right py-2 px-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costData.by_model.map((m, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 px-2 font-mono text-[11px]">
                          {m.model.replace(/^.*\//, "")}
                        </td>
                        <td className="py-1.5 px-2 capitalize">{m.step}</td>
                        <td className="text-right py-1.5 px-2">{m.calls}</td>
                        <td className="text-right py-1.5 px-2 text-muted-foreground">
                          {((m.input_tokens + m.output_tokens) / 1000).toFixed(0)}k
                        </td>
                        <td className="text-right py-1.5 px-2 font-medium">
                          ${m.estimated_cost.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Top cases by cost */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Most Expensive Cases</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-2">Case</th>
                      <th className="text-right py-2 px-2">Tokens</th>
                      <th className="text-right py-2 px-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costData.top_cases.slice(0, 10).map((c) => (
                      <tr
                        key={c.case_id}
                        className="border-b border-border/50 cursor-pointer hover:bg-muted/50"
                        onClick={() =>
                          (window.location.href = `/requests/detail-v2?id=${c.case_id}`)
                        }
                      >
                        <td className="py-1.5 px-2">
                          <span className="font-medium">{c.case_name}</span>
                          <span className="text-muted-foreground ml-1 text-[10px]">
                            {c.agency_name}
                          </span>
                        </td>
                        <td className="text-right py-1.5 px-2 text-muted-foreground">
                          {((c.input_tokens + c.output_tokens) / 1000).toFixed(0)}k
                        </td>
                        <td className="text-right py-1.5 px-2 font-medium">
                          ${c.estimated_cost.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function KPICard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: "green" | "red" | "amber";
}) {
  const accentClass =
    accent === "green"
      ? "text-green-400"
      : accent === "red"
        ? "text-red-400"
        : accent === "amber"
          ? "text-amber-400"
          : "text-foreground";

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          {label}
        </p>
        <p className={`text-xl font-bold ${accentClass}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
