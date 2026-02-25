"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "./auth-provider";

export function LoginForm() {
  const { login, error } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password) return;
    setSubmitting(true);
    await login(name.trim(), password);
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <form onSubmit={handleSubmit} className="w-full max-w-xs space-y-4">
        <div className="text-center mb-8">
          <h1 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
            AUTOBOT
          </h1>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wide">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            autoComplete="username"
            className="w-full h-9 px-3 text-sm bg-card border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wide">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full h-9 px-3 text-sm bg-card border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim() || !password}
          className="w-full h-9 text-xs font-medium uppercase tracking-wider bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
