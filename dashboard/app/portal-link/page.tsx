"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Loader2, ArrowLeft, UserPlus, LogIn, Check } from "lucide-react";

interface PortalInfo {
  portal_user_id: string | null;
  discord_id: string | null;
  email: string | null;
  username: string | null;
  suggested_handle: string | null;
}

interface PendingData {
  success: boolean;
  linked: boolean;
  linkRequired: boolean;
  portal: PortalInfo;
  user: { id: number; name: string; email: string } | null;
  suggested_existing_user: {
    id: number;
    name: string;
    email: string;
  } | null;
}

interface NotionName {
  name: string;
  email: string | null;
  linked_user_id: number | null;
  linked_user_name: string | null;
}

type Step = "loading" | "choose" | "link-existing" | "create-account" | "notion-link" | "done";

export default function PortalLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PortalLinkContent />
    </Suspense>
  );
}

function PortalLinkContent() {
  const searchParams = useSearchParams();
  const portalToken = searchParams.get("portal_token") || "";
  const next = searchParams.get("next") || "/gated";

  const [step, setStep] = useState<Step>("loading");
  const [pending, setPending] = useState<PendingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Link existing account form
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [linking, setLinking] = useState(false);

  // Create account form
  const [newName, setNewName] = useState("");
  const [newHandle, setNewHandle] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sigName, setSigName] = useState("");
  const [sigTitle, setSigTitle] = useState("");
  const [sigOrg, setSigOrg] = useState("");
  const [sigPhone, setSigPhone] = useState("");
  const [addrStreet, setAddrStreet] = useState("");
  const [addrStreet2, setAddrStreet2] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrState, setAddrState] = useState("");
  const [addrZip, setAddrZip] = useState("");
  const [creating, setCreating] = useState(false);

  // Notion link step
  const [notionNames, setNotionNames] = useState<NotionName[]>([]);
  const [linkedUserId, setLinkedUserId] = useState<number | null>(null);
  const [savingNotion, setSavingNotion] = useState(false);

  // Check token on mount
  useEffect(() => {
    if (!portalToken) {
      setError("No portal token provided. Please log in through the portal.");
      setStep("choose");
      return;
    }

    fetch(`/api/auth/portal/pending?portal_token=${encodeURIComponent(portalToken)}`)
      .then((r) => r.json())
      .then((data: PendingData) => {
        if (data.linked && data.user) {
          // Already linked — just redirect through portal auth to set cookie
          window.location.assign(
            `/api/auth/portal?portal_token=${encodeURIComponent(portalToken)}&next=${encodeURIComponent(next)}`
          );
          return;
        }
        setPending(data);
        setNewName(data.portal?.username || "");
        setNewHandle(data.portal?.suggested_handle || "");
        setSigName(data.portal?.username || "");
        if (data.suggested_existing_user) {
          setLoginName(data.suggested_existing_user.name);
        }
        setStep("choose");
      })
      .catch(() => {
        setError("Invalid or expired portal token. Please try logging in again.");
        setStep("choose");
      });
  }, [portalToken, next]);

  const goToNotionStep = async (userId: number) => {
    setLinkedUserId(userId);
    setError(null);
    try {
      const res = await fetch("/api/users/notion-names");
      const data = await res.json();
      if (data.success && data.names?.length > 0) {
        // Only show names not already linked to another user
        const available = (data.names as NotionName[]).filter(
          (n) => !n.linked_user_id || n.linked_user_id === userId
        );
        if (available.length > 0) {
          setNotionNames(available);
          setStep("notion-link");
          return;
        }
      }
    } catch {}
    // No Notion names to link — skip to done
    finishOnboarding();
  };

  const finishOnboarding = () => {
    setStep("done");
    setTimeout(() => {
      window.location.assign(next);
    }, 1000);
  };

  const handleNotionLink = async (notionName: string) => {
    if (!linkedUserId) return;
    setSavingNotion(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${linkedUserId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notion_name: notionName }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save");
      }
      finishOnboarding();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingNotion(false);
    }
  };

  const handleLinkExisting = async () => {
    setLinking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/portal/link-existing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          portal_token: portalToken,
          name: loginName.trim(),
          password: loginPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to link account");
      }
      await goToNotionStep(data.user.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLinking(false);
    }
  };

  const handleCreateAccount = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/portal/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          portal_token: portalToken,
          name: newName.trim(),
          email_handle: newHandle.trim().toLowerCase(),
          password: newPassword,
          signature_name: sigName || newName.trim(),
          signature_title: sigTitle || undefined,
          signature_organization: sigOrg || undefined,
          signature_phone: sigPhone || undefined,
          address_street: addrStreet || undefined,
          address_street2: addrStreet2 || undefined,
          address_city: addrCity || undefined,
          address_state: addrState || undefined,
          address_zip: addrZip || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to create account");
      }
      await goToNotionStep(data.user.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  if (step === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground uppercase tracking-widest">
            Verifying portal identity...
          </p>
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <Check className="h-6 w-6 text-green-400 mx-auto" />
          <p className="text-sm text-foreground">Account linked successfully</p>
          <p className="text-xs text-muted-foreground">Redirecting...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
            AUTOBOT
          </h1>
          <p className="text-sm text-foreground">
            {step === "choose" && "Link your portal account"}
            {step === "link-existing" && "Sign in to your existing account"}
            {step === "create-account" && "Set up your new account"}
            {step === "notion-link" && "Link your Notion identity"}
          </p>
          {pending?.portal?.username && step === "choose" && (
            <p className="text-xs text-muted-foreground">
              Portal identity: {pending.portal.username}
              {pending.portal.email && ` (${pending.portal.email})`}
            </p>
          )}
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        {/* Step: Choose */}
        {step === "choose" && (
          <div className="space-y-3">
            {pending?.suggested_existing_user && (
              <div className="text-xs text-muted-foreground bg-muted rounded px-3 py-2">
                We found an existing account that may be yours:{" "}
                <span className="text-foreground font-medium">
                  {pending.suggested_existing_user.name}
                </span>{" "}
                ({pending.suggested_existing_user.email})
              </div>
            )}

            <Button
              variant="outline"
              className="w-full h-12 justify-start gap-3"
              onClick={() => {
                setError(null);
                setStep("link-existing");
              }}
            >
              <LogIn className="h-4 w-4 shrink-0" />
              <div className="text-left">
                <div className="text-sm">Use existing account</div>
                <div className="text-xs text-muted-foreground">
                  Sign in and link your portal identity
                </div>
              </div>
            </Button>

            <Button
              variant="outline"
              className="w-full h-12 justify-start gap-3"
              onClick={() => {
                setError(null);
                setStep("create-account");
              }}
            >
              <UserPlus className="h-4 w-4 shrink-0" />
              <div className="text-left">
                <div className="text-sm">Create new account</div>
                <div className="text-xs text-muted-foreground">
                  Set up email, signature, and mailing address
                </div>
              </div>
            </Button>
          </div>
        )}

        {/* Step: Link existing account */}
        {step === "link-existing" && (
          <div className="space-y-4">
            <button
              onClick={() => { setStep("choose"); setError(null); }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder="Your Autobot username"
                  className="h-9 text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Password</Label>
                <Input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Your password"
                  className="h-9 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && loginName && loginPassword) handleLinkExisting();
                  }}
                />
              </div>
            </div>

            <Button
              className="w-full"
              onClick={handleLinkExisting}
              disabled={linking || !loginName.trim() || !loginPassword}
            >
              {linking && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
              Sign in and link
            </Button>
          </div>
        )}

        {/* Step: Create new account */}
        {step === "create-account" && (
          <div className="space-y-4">
            <button
              onClick={() => { setStep("choose"); setError(null); }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>

            {/* Account basics */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Account
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Display Name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Samuel Hylton"
                  className="h-8 text-xs"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email Handle</Label>
                <div className="flex items-center gap-0">
                  <Input
                    value={newHandle}
                    onChange={(e) =>
                      setNewHandle(
                        e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, "")
                      )
                    }
                    placeholder="samuel"
                    className="h-8 text-xs rounded-r-none border-r-0"
                  />
                  <span className="h-8 flex items-center px-2 border rounded-r-md bg-muted text-xs text-muted-foreground whitespace-nowrap">
                    @foib-request.com
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  This is the email address agencies will see on FOIA requests.
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Choose a password (min 4 chars)"
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <Separator />

            {/* Signature */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Email Signature
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={sigName}
                    onChange={(e) => setSigName(e.target.value)}
                    placeholder="Samuel Hylton"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Title</Label>
                  <Input
                    value={sigTitle}
                    onChange={(e) => setSigTitle(e.target.value)}
                    placeholder="Documentary Researcher"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Organization</Label>
                  <Input
                    value={sigOrg}
                    onChange={(e) => setSigOrg(e.target.value)}
                    placeholder="Dr Insanity Media"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Phone</Label>
                  <Input
                    value={sigPhone}
                    onChange={(e) => setSigPhone(e.target.value)}
                    placeholder="209-800-7702"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Address */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Mailing Address
                <span className="ml-1 font-normal normal-case">
                  (used in formal FOIA requests)
                </span>
              </p>
              <div className="space-y-2">
                <Input
                  value={addrStreet}
                  onChange={(e) => setAddrStreet(e.target.value)}
                  placeholder="Street address"
                  className="h-8 text-xs"
                />
                <Input
                  value={addrStreet2}
                  onChange={(e) => setAddrStreet2(e.target.value)}
                  placeholder="Apt / Suite (optional)"
                  className="h-8 text-xs"
                />
                <div className="grid grid-cols-3 gap-2">
                  <Input
                    value={addrCity}
                    onChange={(e) => setAddrCity(e.target.value)}
                    placeholder="City"
                    className="h-8 text-xs"
                  />
                  <Input
                    value={addrState}
                    onChange={(e) => setAddrState(e.target.value)}
                    placeholder="State"
                    className="h-8 text-xs"
                  />
                  <Input
                    value={addrZip}
                    onChange={(e) => setAddrZip(e.target.value)}
                    placeholder="Zip"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Signature preview */}
            {(sigName || sigTitle || sigOrg) && (
              <>
                <Separator />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Preview
                  </p>
                  <div className="bg-muted rounded p-3">
                    <pre className="text-xs whitespace-pre-wrap font-[inherit] text-muted-foreground">
                      {[
                        sigName,
                        sigTitle,
                        sigOrg,
                        sigPhone,
                        addrStreet,
                        addrStreet2,
                        [addrCity, addrState, addrZip].filter(Boolean).join(", "),
                      ]
                        .filter(Boolean)
                        .join("\n")}
                    </pre>
                  </div>
                </div>
              </>
            )}

            <Button
              className="w-full"
              onClick={handleCreateAccount}
              disabled={
                creating ||
                !newName.trim() ||
                !newHandle.trim() ||
                !newPassword ||
                newPassword.length < 4
              }
            >
              {creating && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
              Create account
            </Button>
          </div>
        )}

        {/* Step: Notion link */}
        {step === "notion-link" && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Select which Notion person you are so cases assigned to you in
              Notion are automatically linked to your account.
            </p>

            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {notionNames.map((n) => {
                const isTaken =
                  n.linked_user_id !== null && n.linked_user_id !== linkedUserId;
                return (
                  <button
                    key={n.name}
                    disabled={savingNotion || isTaken}
                    onClick={() => handleNotionLink(n.name)}
                    className={
                      "w-full flex items-center justify-between rounded-md border px-3 py-2.5 text-left transition-colors " +
                      (isTaken
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:bg-card hover:border-foreground/20")
                    }
                  >
                    <div>
                      <div className="text-sm text-foreground">{n.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {n.email || ""}
                        {isTaken && `${n.email ? " \u00b7 " : ""}linked to ${n.linked_user_name}`}
                      </div>
                    </div>
                    {savingNotion ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    ) : null}
                  </button>
                );
              })}
            </div>

            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={finishOnboarding}
            >
              Skip for now
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
