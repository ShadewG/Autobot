"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetcher } from "@/lib/api";
import type { AgenciesListResponse } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { Search, Loader2, Building, Mail, Globe } from "lucide-react";

export default function AgenciesPage() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data, error, isLoading } = useSWR<AgenciesListResponse>(
    "/agencies",
    fetcher
  );

  // Filter agencies locally
  const filterAgencies = (agencies: typeof data) => {
    if (!agencies?.agencies) return [];

    if (!searchQuery) return agencies.agencies;

    const query = searchQuery.toLowerCase();
    return agencies.agencies.filter(
      (a) =>
        a.name?.toLowerCase().includes(query) ||
        a.state?.toLowerCase().includes(query)
    );
  };

  const filteredAgencies = filterAgencies(data);

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load agencies</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agencies</h1>
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agencies..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Agencies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.count || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Portal Agencies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {data?.agencies?.filter((a) => a.submission_method === "PORTAL")
                .length || 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Email-Only Agencies
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {data?.agencies?.filter((a) => a.submission_method === "EMAIL")
                .length || 0}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agency Name</TableHead>
                  <TableHead className="w-[80px]">State</TableHead>
                  <TableHead className="w-[120px]">Method</TableHead>
                  <TableHead className="w-[100px]">Requests</TableHead>
                  <TableHead className="w-[100px]">Avg Response</TableHead>
                  <TableHead className="w-[120px]">Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAgencies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8">
                      No agencies found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAgencies.map((agency) => (
                    <TableRow
                      key={agency.id}
                      className="cursor-pointer"
                      onClick={() =>
                        (window.location.href = `/agencies/detail?id=${agency.id}`)
                      }
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Building className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{agency.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>{agency.state}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="gap-1"
                        >
                          {agency.submission_method === "PORTAL" ? (
                            <Globe className="h-3 w-3" />
                          ) : (
                            <Mail className="h-3 w-3" />
                          )}
                          {agency.submission_method}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">
                          {agency.total_requests}
                        </span>
                        <span className="text-muted-foreground text-xs ml-1">
                          ({agency.completed_requests} done)
                        </span>
                      </TableCell>
                      <TableCell>
                        {agency.avg_response_days !== null
                          ? `${agency.avg_response_days}d`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelativeTime(agency.last_activity_at)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
