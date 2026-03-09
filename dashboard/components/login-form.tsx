"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useAuth } from "./auth-provider";

interface LoginUser {
  id: number;
  name: string;
}

export function LoginForm() {
  const { login, error } = useAuth();
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [touched, setTouched] = useState({ name: false, password: false });

  // Fetch active users for the dropdown
  useEffect(() => {
    fetch("/api/auth/users")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.users) setUsers(data.users);
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched({ name: true, password: true });
    if (!name.trim() && !password) {
      setValidationError("Name and password are required");
      return;
    }
    if (!name.trim()) {
      setValidationError("Select your name");
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
          {users.length > 0 ? (
            <select
              value={name}
              onChange={(e) => { setName(e.target.value); setValidationError(null); }}
              autoFocus
              className={`w-full h-9 px-3 text-sm bg-card border text-foreground focus:outline-none focus:ring-1 focus:ring-ring appearance-none cursor-pointer ${showNameError ? "border-destructive" : "border-border"}`}
            >
              <option value="">Select your name...</option>
              {users.map((u) => (
                <option key={u.id} value={u.name}>
                  {u.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setValidationError(null); }}
              autoFocus
              autoComplete="username"
              placeholder="Your name"
              className={`w-full h-9 px-3 text-sm bg-card border text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${showNameError ? "border-destructive" : "border-border"}`}
            />
          )}
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
