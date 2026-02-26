"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "./auth-provider";

export function LoginForm() {
  const { login, error } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [touched, setTouched] = useState({ name: false, password: false });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, password: true });
    if (!name.trim() && !password) {
      setValidationError("Name and password are required");
      return;
    }
    if (!name.trim()) {
      setValidationError("Name is required");
      return;
    }
    if (!password) {
      setValidationError("Password is required");
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    await login(name.trim(), password);
    setSubmitting(false);
  };

  const displayError = validationError || error;
  const showNameError = touched.name && !name.trim();
  const showPasswordError = touched.password && !password;

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
            onChange={(e) => { setName(e.target.value); setValidationError(null); }}
            autoFocus
            autoComplete="username"
            className={`w-full h-9 px-3 text-sm bg-card border text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${showNameError ? "border-destructive" : "border-border"}`}
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground uppercase tracking-wide">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setValidationError(null); }}
            autoComplete="current-password"
            className={`w-full h-9 px-3 text-sm bg-card border text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${showPasswordError ? "border-destructive" : "border-border"}`}
          />
        </div>

        {displayError && (
          <p className="text-xs text-destructive">{displayError}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full h-9 text-xs font-medium uppercase tracking-wider bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
