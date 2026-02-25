"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Check, Pencil } from "lucide-react";
import { fetcher } from "@/lib/api";

interface User {
  id: number;
  name: string;
  email_handle: string;
  signature_name: string | null;
  signature_title: string | null;
  signature_organization: string | null;
  signature_phone: string | null;
  address_street: string | null;
  address_street2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
}

function UserSettings({ user }: { user: User }) {
  const [form, setForm] = useState({
    signature_name: user.signature_name || user.name || "",
    signature_title: user.signature_title || "",
    signature_organization: user.signature_organization || "",
    signature_phone: user.signature_phone || "",
    address_street: user.address_street || "",
    address_street2: user.address_street2 || "",
    address_city: user.address_city || "",
    address_state: user.address_state || "",
    address_zip: user.address_zip || "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when user changes
  useEffect(() => {
    setForm({
      signature_name: user.signature_name || user.name || "",
      signature_title: user.signature_title || "",
      signature_organization: user.signature_organization || "",
      signature_phone: user.signature_phone || "",
      address_street: user.address_street || "",
      address_street2: user.address_street2 || "",
      address_city: user.address_city || "",
      address_state: user.address_state || "",
      address_zip: user.address_zip || "",
    });
    setSaved(false);
    setError(null);
  }, [user.id]);

  const set = (field: string, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || '/api';
      const res = await fetch(`${apiBase}/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Save failed");
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // Build live preview of what the signature will look like
  const signaturePreview = [
    form.signature_name,
    form.signature_title,
    form.signature_organization,
    form.signature_phone,
    form.address_street,
    form.address_street2,
    [form.address_city, form.address_state, form.address_zip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Pencil className="h-4 w-4" />
          {user.name}
          <span className="text-xs text-muted-foreground font-normal">
            @{user.email_handle}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Signature fields */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Email Signature
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={form.signature_name}
                onChange={(e) => set("signature_name", e.target.value)}
                placeholder="Samuel Hylton"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Title</Label>
              <Input
                value={form.signature_title}
                onChange={(e) => set("signature_title", e.target.value)}
                placeholder="Documentary Researcher, Dr Insanity"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Organization</Label>
              <Input
                value={form.signature_organization}
                onChange={(e) => set("signature_organization", e.target.value)}
                placeholder="Dr Insanity"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Phone</Label>
              <Input
                value={form.signature_phone}
                onChange={(e) => set("signature_phone", e.target.value)}
                placeholder="209-800-7702"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>

        {/* Address fields */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Mailing Address
            <span className="ml-1 font-normal normal-case">(used in formal FOIA requests)</span>
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1">
              <Label className="text-xs">Street</Label>
              <Input
                value={form.address_street}
                onChange={(e) => set("address_street", e.target.value)}
                placeholder="123 Main St"
                className="h-8 text-xs"
              />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <Label className="text-xs">Street 2</Label>
              <Input
                value={form.address_street2}
                onChange={(e) => set("address_street2", e.target.value)}
                placeholder="Suite 100"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">City</Label>
              <Input
                value={form.address_city}
                onChange={(e) => set("address_city", e.target.value)}
                placeholder="Los Angeles"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">State</Label>
                <Input
                  value={form.address_state}
                  onChange={(e) => set("address_state", e.target.value)}
                  placeholder="CA"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Zip</Label>
                <Input
                  value={form.address_zip}
                  onChange={(e) => set("address_zip", e.target.value)}
                  placeholder="90001"
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Live preview */}
        {signaturePreview && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Preview
            </p>
            <div className="bg-muted rounded p-3">
              <pre className="text-xs whitespace-pre-wrap font-[inherit] text-muted-foreground">
                {signaturePreview}
              </pre>
            </div>
          </div>
        )}

        {/* Save */}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && (
          <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/10 border border-green-700/30 rounded px-3 py-2">
            <Check className="h-3 w-3" />
            Settings saved successfully
          </div>
        )}
        <Button
          onClick={handleSave}
          disabled={saving}
          size="sm"
          className="w-full sm:w-auto"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3 w-3 mr-1.5 text-green-400" />
          ) : null}
          {saved ? "Saved" : "Save changes"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data, error, isLoading } = useSWR<{ success: boolean; users: User[] }>(
    "/users",
    fetcher
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 py-4">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Email signatures are automatically appended to all outgoing FOIA correspondence.
        </p>
      </div>

      <Separator />

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive">Failed to load users.</p>
      )}
      {data?.users?.map((user) => (
        <UserSettings key={user.id} user={user} />
      ))}
    </div>
  );
}
