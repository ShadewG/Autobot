"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { fetcher } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Users,
  Activity,
  BarChart3,
  Shield,
  ShieldCheck,
  Plus,
  Eye,
  UserX,
  UserCheck,
  KeyRound,
  Loader2,
  AlertTriangle,
  HeartPulse,
  Bug,
  Clock,
  CalendarX,
  XCircle,
  MailX,
  CheckCircle2,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";

interface AdminUser {
  id: number;
  name: string;
  email_handle: string;
  email: string;
  active: boolean;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
  total_cases: number;
  active_cases: number;
  needs_review: number;
  last_activity_at: string | null;
  last_activity_description: string | null;
}

interface ActivityEntry {
  id: number;
  event_type: string;
  case_id: number | null;
  description: string;
  metadata: any;
  user_id: string | null;
  user_name: string | null;
  agency_name: string | null;
  case_name: string | null;
  created_at: string;
}

interface Overview {
  users: { active_users: number; inactive_users: number; total_users: number };
  cases: { total_cases: number; active_cases: number; needs_review: number; id_state_cases: number };
  status_breakdown: { status: string; count: number }[];
  recent_activity: ActivityEntry[];
  operational?: {
    portal_hard_timeout_total_1h: number;
    portal_soft_timeout_total_1h: number;
    process_inbound_superseded_total_1h: number;
    thresholds: {
      portal_hard_timeout_total_1h: number;
      process_inbound_superseded_total_1h: number;
    };
    alerts: {
      portal_hard_timeout: boolean;
      process_inbound_superseded: boolean;
    };
  };
}

interface AdminCase {
  id: number;
  case_name: string;
  agency_name: string;
  status: string;
  substatus: string | null;
  requires_human: boolean;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
  updated_at: string;
}

interface HealthIssueCase {
  id: number;
  agency_name: string;
  status?: string;
  substatus?: string;
  updated_at?: string;
  deadline_date?: string;
  error?: string;
  trigger_type?: string;
  ended_at?: string;
  event_type?: string;
  created_at?: string;
}

interface UserHealth {
  user_id: number | null;
  user_name: string;
  stuck: HealthIssueCase[];
  overdue: HealthIssueCase[];
  failed_runs: HealthIssueCase[];
  bounced: HealthIssueCase[];
  total_issues: number;
}

interface BugReport {
  id: number;
  title: string;
  description: string;
  case_id: number | null;
  status: string;
  priority: string;
  created_by: number | null;
  created_by_email: string | null;
  created_at: string;
  reporter_name: string | null;
  agency_name: string | null;
  case_status: string | null;
}

interface BuggedCase {
  id: number;
  agency_name: string;
  case_name: string;
  user_id: number | null;
  user_name: string | null;
  updated_at: string;
  substatus: string | null;
  bug_description: string | null;
  bugged_at: string | null;
}

interface HealthData {
  success: boolean;
  user_health: UserHealth[];
  bug_reports: BugReport[];
  bugged_cases: BuggedCase[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";
const adminEndpoint = (path: string) => `/admin${path}`;
const adminApiUrl = (path: string) => `${API_BASE}/admin${path}`;

// ── Overview Tab ──────────────────────────────────────────────

function OverviewTab() {
  const { data, isLoading, error } = useSWR<{ success: boolean } & Overview>(
    adminEndpoint("/overview"),
    fetcher,
    { refreshInterval: 30000 }
  );

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>;
  }
  if (error || !data) {
    return <div className="text-xs text-destructive py-8">Failed to load admin overview.</div>;
  }

  const { users, cases, status_breakdown, recent_activity, operational } = data;

  return (
    <div className="space-y-6">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Active Users" value={users.active_users} />
        <StatCard label="Active Cases" value={cases.active_cases} />
        <StatCard label="Needs Review" value={cases.needs_review} variant="warning" />
        <StatCard label="Awaiting ID" value={cases.id_state_cases} variant="muted" />
      </div>

      {/* Status Breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Case Status Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {status_breakdown.map((s) => (
              <div key={s.status} className="flex items-center justify-between p-2 bg-muted/50 rounded text-xs">
                <span className="text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
                <span className="font-mono">{s.count}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Operational Alerts */}
      {operational && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Operational Alerts (1h)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="flex items-center justify-between p-2 rounded bg-muted/40">
              <span>Portal hard timeouts</span>
              <div className="flex items-center gap-2">
                <span className="font-mono">
                  {operational.portal_hard_timeout_total_1h} / {operational.thresholds.portal_hard_timeout_total_1h}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] h-4",
                    operational.alerts.portal_hard_timeout
                      ? "text-red-400 border-red-400/30"
                      : "text-emerald-400 border-emerald-400/30"
                  )}
                >
                  {operational.alerts.portal_hard_timeout ? "ALERT" : "OK"}
                </Badge>
              </div>
            </div>
            <div className="flex items-center justify-between p-2 rounded bg-muted/40">
              <span>Process-inbound superseded runs</span>
              <div className="flex items-center gap-2">
                <span className="font-mono">
                  {operational.process_inbound_superseded_total_1h} / {operational.thresholds.process_inbound_superseded_total_1h}
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] h-4",
                    operational.alerts.process_inbound_superseded
                      ? "text-red-400 border-red-400/30"
                      : "text-emerald-400 border-emerald-400/30"
                  )}
                >
                  {operational.alerts.process_inbound_superseded ? "ALERT" : "OK"}
                </Badge>
              </div>
            </div>
            <div className="text-muted-foreground">
              Soft portal timeouts (1h): <span className="font-mono">{operational.portal_soft_timeout_total_1h}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2"><Activity className="h-4 w-4" /> Recent System Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityList entries={recent_activity} />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Users Tab ─────────────────────────────────────────────────

function UsersTab() {
  const { data, isLoading, error, mutate } = useSWR<{ success: boolean; users: AdminUser[] }>(
    adminEndpoint("/users"),
    fetcher
  );
  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const toggleAdmin = async (user: AdminUser) => {
    await fetch(adminApiUrl(`/users/${user.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ is_admin: !user.is_admin }),
    });
    mutate();
  };

  const toggleActive = async (user: AdminUser) => {
    await fetch(adminApiUrl(`/users/${user.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ active: !user.active }),
    });
    mutate();
  };

  const resetPassword = async () => {
    if (!resetTarget || !newPassword) return;
    setSaving(true);
    await fetch(adminApiUrl(`/users/${resetTarget.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password: newPassword }),
    });
    setSaving(false);
    setResetTarget(null);
    setNewPassword("");
  };

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>;
  }
  if (error || !data) {
    return <div className="text-xs text-destructive py-8">Failed to load users.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{data.users.length} users</p>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-3 w-3 mr-1" /> Create User
        </Button>
      </div>

      <div className="space-y-2">
        {data.users.map((u) => (
          <Card key={u.id} className={cn(!u.active && "opacity-50")}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{u.name}</span>
                      {u.is_admin && (
                        <Badge variant="outline" className="text-[10px] h-4 text-amber-400 border-amber-400/30">
                          ADMIN
                        </Badge>
                      )}
                      {!u.active && (
                        <Badge variant="outline" className="text-[10px] h-4 text-red-400 border-red-400/30">
                          INACTIVE
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">@{u.email_handle}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs">
                  <div className="text-right">
                    <div className="font-mono">{u.active_cases} active / {u.total_cases} total</div>
                    <div className="text-muted-foreground">
                      {u.last_activity_at
                        ? `Last active ${formatDate(u.last_activity_at)}`
                        : "No activity"}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      title={u.is_admin ? "Remove admin" : "Make admin"}
                      onClick={() => toggleAdmin(u)}
                    >
                      {u.is_admin ? <ShieldCheck className="h-3.5 w-3.5 text-amber-400 mr-1" /> : <Shield className="h-3.5 w-3.5 mr-1" />}
                      {u.is_admin ? "Unadmin" : "Admin"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      title="Reset password"
                      onClick={() => { setResetTarget(u); setNewPassword(""); }}
                    >
                      <KeyRound className="h-3.5 w-3.5 mr-1" />
                      Reset pw
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      title={u.active ? "Deactivate" : "Reactivate"}
                      onClick={() => toggleActive(u)}
                    >
                      {u.active ? <UserX className="h-3.5 w-3.5 mr-1" /> : <UserCheck className="h-3.5 w-3.5 mr-1" />}
                      {u.active ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create User Dialog */}
      <CreateUserDialog open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => mutate()} />

      {/* Reset Password Dialog */}
      <Dialog open={!!resetTarget} onOpenChange={() => setResetTarget(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Reset Password — {resetTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">New Password</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="h-8 text-xs"
              placeholder="Enter new password"
            />
          </div>
          <DialogFooter>
            <Button size="sm" disabled={!newPassword || saving} onClick={resetPassword}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Create User Dialog ────────────────────────────────────────

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(adminApiUrl("/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, email_handle: handle, password, is_admin: isAdmin }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      onCreated();
      onClose();
      setName(""); setHandle(""); setPassword(""); setIsAdmin(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Create User</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" placeholder="Jane Smith" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Email Handle</Label>
            <Input value={handle} onChange={(e) => setHandle(e.target.value)} className="h-8 text-xs" placeholder="jane-smith" />
            <p className="text-[10px] text-muted-foreground">{handle || "handle"}@foib-request.com</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-8 text-xs" />
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} className="rounded" />
            Admin privileges
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!name || !handle || !password || saving} onClick={handleCreate}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Activity Tab ──────────────────────────────────────────────

function ActivityTab() {
  const [filterUserId, setFilterUserId] = useState<string>("");
  const url = filterUserId
    ? `${adminEndpoint("/activity")}?limit=200&user_id=${filterUserId}`
    : `${adminEndpoint("/activity")}?limit=200`;
  const { data, isLoading, error } = useSWR<{ success: boolean; activity: ActivityEntry[] }>(url, fetcher, { refreshInterval: 15000 });
  const { data: usersData } = useSWR<{ success: boolean; users: AdminUser[] }>(adminEndpoint("/users"), fetcher);

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>;
  }
  if (error || !data) {
    return <div className="text-xs text-destructive py-8">Failed to load activity log.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={filterUserId}
          onChange={(e) => setFilterUserId(e.target.value)}
          className="h-8 px-2 text-xs bg-card border border-border rounded"
        >
          <option value="">All Users</option>
          {usersData?.users?.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{data.activity.length} events</p>
      </div>
      <ActivityList entries={data.activity} />
    </div>
  );
}

// ── Cases Tab ─────────────────────────────────────────────────

function CasesTab() {
  const [filterUserId, setFilterUserId] = useState<string>("");
  const url = filterUserId
    ? `${adminEndpoint("/cases")}?limit=100&user_id=${filterUserId}`
    : `${adminEndpoint("/cases")}?limit=100`;
  const { data, isLoading, error } = useSWR<{ success: boolean; cases: AdminCase[] }>(url, fetcher);
  const { data: usersData } = useSWR<{ success: boolean; users: AdminUser[] }>(adminEndpoint("/users"), fetcher);

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>;
  }
  if (error || !data) {
    return <div className="text-xs text-destructive py-8">Failed to load cases.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={filterUserId}
          onChange={(e) => setFilterUserId(e.target.value)}
          className="h-8 px-2 text-xs bg-card border border-border rounded"
        >
          <option value="">All Users</option>
          {usersData?.users?.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{data.cases.length} active cases</p>
      </div>

      <div className="space-y-1">
        {data.cases.map((c) => (
          <a
            key={c.id}
            href={`/requests/detail-v2?id=${c.id}`}
            className="flex items-center justify-between p-2 hover:bg-muted/50 rounded text-xs transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-muted-foreground w-12 shrink-0">#{c.id}</span>
              <span className="truncate">{c.agency_name || c.case_name}</span>
              {c.user_name && (
                <Badge variant="outline" className="text-[10px] h-4 shrink-0">
                  {c.user_name}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {c.requires_human && <AlertTriangle className="h-3 w-3 text-amber-400" />}
              <Badge variant="secondary" className="text-[10px] h-4">
                {c.status.replace(/_/g, " ")}
              </Badge>
            </div>
          </a>
        ))}
        {data.cases.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">No active cases</p>
        )}
      </div>
    </div>
  );
}

// ── Health Tab ────────────────────────────────────────────────

function HealthTab() {
  const { data, isLoading, error } = useSWR<HealthData>(
    adminEndpoint("/health"),
    fetcher,
    { refreshInterval: 60000 }
  );

  if (isLoading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>;
  }
  if (error || !data) {
    return <div className="text-xs text-destructive py-8">Failed to load health data.</div>;
  }

  const { user_health, bug_reports, bugged_cases } = data;
  const totalIssues = user_health.reduce((sum, u) => sum + u.total_issues, 0);
  const openBugs = bug_reports.filter(b => b.status === "open" || b.status === "in_progress").length;

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Issues" value={totalIssues} variant={totalIssues > 0 ? "warning" : undefined} />
        <StatCard label="Stuck Cases" value={user_health.reduce((s, u) => s + u.stuck.length, 0)} variant="warning" />
        <StatCard label="Overdue" value={user_health.reduce((s, u) => s + u.overdue.length, 0)} variant="warning" />
        <StatCard label="Open Bug Reports" value={openBugs} variant={openBugs > 0 ? "warning" : "muted"} />
      </div>

      {/* Per-user health cards */}
      {user_health.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <HeartPulse className="h-4 w-4" /> Per-User Health
          </h3>
          {user_health.map((uh) => (
            <UserHealthCard key={uh.user_id ?? "unassigned"} health={uh} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-6 text-center">
            <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">All clear — no issues detected</p>
          </CardContent>
        </Card>
      )}

      {/* Bugged Cases */}
      {bugged_cases.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Bug className="h-4 w-4 text-red-400" /> Bugged Cases ({bugged_cases.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {bugged_cases.map((bc) => (
                <a
                  key={bc.id}
                  href={`/requests/detail-v2?id=${bc.id}`}
                  className="flex items-center justify-between p-2 hover:bg-muted/50 rounded text-xs transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-muted-foreground w-12 shrink-0">#{bc.id}</span>
                    <span className="truncate">{bc.agency_name || bc.case_name}</span>
                    {bc.user_name && (
                      <Badge variant="outline" className="text-[10px] h-4 shrink-0">{bc.user_name}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground shrink-0">
                    {bc.bugged_at && (
                      <span className="font-mono">{formatDate(bc.bugged_at)}</span>
                    )}
                    <Badge variant="outline" className="text-[10px] h-4 text-red-400 border-red-400/30">BUGGED</Badge>
                  </div>
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bug Reports */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bug className="h-4 w-4" /> Bug Reports ({bug_reports.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bug_reports.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No bug reports</p>
          ) : (
            <div className="space-y-1 max-h-[400px] overflow-y-auto">
              {bug_reports.map((br) => (
                <div
                  key={br.id}
                  className="flex items-start justify-between p-2 hover:bg-muted/30 rounded text-xs gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <BugStatusBadge status={br.status} />
                      <BugPriorityBadge priority={br.priority} />
                      {br.case_id && (
                        <a
                          href={`/requests/detail-v2?id=${br.case_id}`}
                          className="font-mono text-muted-foreground hover:text-foreground"
                        >
                          #{br.case_id}
                        </a>
                      )}
                    </div>
                    <p className="text-foreground truncate">{br.title}</p>
                    <p className="text-muted-foreground text-[10px] mt-0.5">
                      {br.reporter_name || br.created_by_email || "Anonymous"}
                      {" -- "}
                      {formatDate(br.created_at)}
                      {br.agency_name && <span> -- {br.agency_name}</span>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UserHealthCard({ health }: { health: UserHealth }) {
  const [expanded, setExpanded] = useState(false);
  const hasIssues = health.total_issues > 0;

  return (
    <Card className={cn(!hasIssues && "opacity-60")}>
      <CardContent className="p-3">
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={() => hasIssues && setExpanded(!expanded)}
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{health.user_name}</span>
            {!hasIssues && (
              <Badge variant="outline" className="text-[10px] h-4 text-emerald-400 border-emerald-400/30">
                ALL CLEAR
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs">
            {health.stuck.length > 0 && (
              <div className="flex items-center gap-1 text-amber-400" title="Stuck cases">
                <Clock className="h-3 w-3" />
                <span className="font-mono">{health.stuck.length}</span>
              </div>
            )}
            {health.overdue.length > 0 && (
              <div className="flex items-center gap-1 text-red-400" title="Overdue deadlines">
                <CalendarX className="h-3 w-3" />
                <span className="font-mono">{health.overdue.length}</span>
              </div>
            )}
            {health.failed_runs.length > 0 && (
              <div className="flex items-center gap-1 text-orange-400" title="Failed runs (48h)">
                <XCircle className="h-3 w-3" />
                <span className="font-mono">{health.failed_runs.length}</span>
              </div>
            )}
            {health.bounced.length > 0 && (
              <div className="flex items-center gap-1 text-red-400" title="Bounced emails">
                <MailX className="h-3 w-3" />
                <span className="font-mono">{health.bounced.length}</span>
              </div>
            )}
            {hasIssues && (
              <span className="text-muted-foreground text-[10px] ml-1">
                {expanded ? "collapse" : "expand"}
              </span>
            )}
          </div>
        </div>

        {expanded && hasIssues && (
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            {health.stuck.length > 0 && (
              <IssueSection
                icon={<Clock className="h-3 w-3 text-amber-400" />}
                label="Stuck (no proposal >24h)"
                cases={health.stuck}
                extraColumn={(c) => (
                  <span className="text-muted-foreground font-mono">
                    {c.status?.replace(/_/g, " ")}
                  </span>
                )}
              />
            )}
            {health.overdue.length > 0 && (
              <IssueSection
                icon={<CalendarX className="h-3 w-3 text-red-400" />}
                label="Overdue Deadlines"
                cases={health.overdue}
                extraColumn={(c) => (
                  <span className="text-red-400 font-mono">
                    {c.deadline_date
                      ? new Date(c.deadline_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      : ""}
                  </span>
                )}
              />
            )}
            {health.failed_runs.length > 0 && (
              <IssueSection
                icon={<XCircle className="h-3 w-3 text-orange-400" />}
                label="Failed Runs (48h)"
                cases={health.failed_runs}
                extraColumn={(c) => (
                  <span className="text-muted-foreground truncate max-w-[200px] inline-block">
                    {c.error}
                  </span>
                )}
              />
            )}
            {health.bounced.length > 0 && (
              <IssueSection
                icon={<MailX className="h-3 w-3 text-red-400" />}
                label="Bounced/Failed Emails"
                cases={health.bounced}
                extraColumn={(c) => (
                  <span className="text-muted-foreground font-mono">
                    {c.event_type?.replace(/_/g, " ")}
                  </span>
                )}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IssueSection({
  icon,
  label,
  cases,
  extraColumn,
}: {
  icon: React.ReactNode;
  label: string;
  cases: HealthIssueCase[];
  extraColumn?: (c: HealthIssueCase) => React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        {icon} {label} ({cases.length})
      </div>
      <div className="space-y-0.5">
        {cases.map((c) => (
          <a
            key={c.id}
            href={`/requests/detail-v2?id=${c.id}`}
            className="flex items-center justify-between p-1.5 hover:bg-muted/50 rounded text-xs transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-muted-foreground w-12 shrink-0">#{c.id}</span>
              <span className="truncate">{c.agency_name || `Case #${c.id}`}</span>
            </div>
            {extraColumn && (
              <div className="text-xs shrink-0 ml-2">{extraColumn(c)}</div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

function BugStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    open: "text-amber-400 border-amber-400/30",
    in_progress: "text-blue-400 border-blue-400/30",
    resolved: "text-emerald-400 border-emerald-400/30",
    closed: "text-muted-foreground border-border",
    wont_fix: "text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px] h-4", colorMap[status] || "")}>
      {status.replace(/_/g, " ").toUpperCase()}
    </Badge>
  );
}

function BugPriorityBadge({ priority }: { priority: string }) {
  if (priority === "medium" || priority === "low") return null;
  const colorMap: Record<string, string> = {
    high: "text-orange-400 border-orange-400/30",
    critical: "text-red-400 border-red-400/30",
  };
  return (
    <Badge variant="outline" className={cn("text-[10px] h-4", colorMap[priority] || "")}>
      {priority.toUpperCase()}
    </Badge>
  );
}

// ── Shared Components ─────────────────────────────────────────

function StatCard({ label, value, variant }: { label: string; value: number; variant?: "warning" | "muted" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn(
          "text-2xl font-mono mt-1",
          variant === "warning" && "text-amber-400",
          variant === "muted" && "text-muted-foreground",
        )}>{value}</p>
      </CardContent>
    </Card>
  );
}

interface DedupedEntry extends ActivityEntry {
  count: number;
}

function deduplicateEntries(entries: ActivityEntry[]): DedupedEntry[] {
  if (entries.length === 0) return [];
  const result: DedupedEntry[] = [];
  for (const entry of entries) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.event_type === entry.event_type &&
      prev.description === entry.description &&
      prev.user_name === entry.user_name
    ) {
      prev.count += 1;
    } else {
      result.push({ ...entry, count: 1 });
    }
  }
  return result;
}

function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground text-center py-4">No activity</p>;
  }

  const deduped = deduplicateEntries(entries);

  return (
    <div className="space-y-0.5 max-h-[500px] overflow-y-auto">
      {deduped.map((e) => (
        <div key={e.id} className="flex items-start gap-3 p-2 hover:bg-muted/30 rounded text-xs">
          <span className="text-muted-foreground shrink-0 w-24 font-mono">
            {new Date(e.created_at).toLocaleString("en-US", {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}
          </span>
          <span className={cn(
            "shrink-0 w-16",
            e.user_name ? "text-foreground" : "text-muted-foreground"
          )}>
            {e.user_name || "system"}
          </span>
          <span className="shrink-0 w-28 text-muted-foreground">{e.event_type.replace(/_/g, " ")}</span>
          <span className="truncate text-muted-foreground">
            {e.description}
            {e.count > 1 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5">
                x{e.count}
              </Badge>
            )}
            {e.agency_name && <span className="ml-1 text-foreground/60">— {e.agency_name}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) {
      router.replace("/gated");
    }
  }, [user, loading, router]);

  if (loading || !user?.is_admin) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Shield className="h-5 w-5" /> Admin
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          System overview, user management, and global activity.
        </p>
      </div>

      <Separator />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="text-xs">
            <BarChart3 className="h-3 w-3 mr-1" /> Overview
          </TabsTrigger>
          <TabsTrigger value="health" className="text-xs">
            <HeartPulse className="h-3 w-3 mr-1" /> Health
          </TabsTrigger>
          <TabsTrigger value="users" className="text-xs">
            <Users className="h-3 w-3 mr-1" /> Users
          </TabsTrigger>
          <TabsTrigger value="activity" className="text-xs">
            <Activity className="h-3 w-3 mr-1" /> Activity Log
          </TabsTrigger>
          <TabsTrigger value="cases" className="text-xs">
            <Eye className="h-3 w-3 mr-1" /> All Cases
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="health" className="mt-4">
          <HealthTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="cases" className="mt-4">
          <CasesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
