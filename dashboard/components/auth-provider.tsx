"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";


interface User {
  id: number;
  name: string;
  email: string;
  is_admin?: boolean;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  redirectToPortal: () => void;
  login: (name: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  error: null,
  redirectToPortal: () => {},
  login: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function getPortalRedirectUrl(nextPath = '/gated') {
  const portalBaseUrl = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://portal-production-fa69.up.railway.app';
  const url = new URL('/api/auth/redirect', portalBaseUrl);
  url.searchParams.set('app', 'autobot');
  url.searchParams.set('returnTo', window.location.origin);
  url.searchParams.set('next', nextPath);
  return url.toString();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const redirectToPortal = useCallback(() => {
    if (typeof window === "undefined") return;
    window.location.assign(getPortalRedirectUrl(window.location.pathname + window.location.search));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    fetch("/api/auth/me", { credentials: "include", signal: controller.signal })
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => null) }))
      .then(({ ok, data }) => {
        if (ok && data?.user) { setUser(data.user); return; }
        // Don't auto-redirect to portal — show login form instead.
        // Auto-redirect causes infinite loops when the portal callback
        // fails to set the auth cookie for new accounts.
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        setLoading(false);
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const login = useCallback(async (name: string, password: string) => {
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (data.success) {
        setUser(data.user);
        return true;
      }
      setError(data.error || "Login failed");
      return false;
    } catch {
      setError("Network error");
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, error, redirectToPortal, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
