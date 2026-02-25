"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import useSWR from "swr";

interface User {
  id: number;
  name: string;
}

interface UserFilterContextValue {
  userId: string;
  setUser: (id: string) => void;
  userParam: string; // e.g. "user_id=3" or ""
  appendUser: (url: string) => string; // append user_id param to URL
}

const STORAGE_KEY = "monitorUserFilter";

const UserFilterContext = createContext<UserFilterContextValue>({
  userId: "",
  setUser: () => {},
  userParam: "",
  appendUser: (url) => url,
});

export function useUserFilter() {
  return useContext(UserFilterContext);
}

export function UserFilterProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string>("");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setUserId(stored);
  }, []);

  const setUser = (id: string) => {
    setUserId(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  const userParam = userId ? `user_id=${userId}` : "";

  const appendUser = (url: string) => {
    if (!userId) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}user_id=${userId}`;
  };

  return (
    <UserFilterContext.Provider value={{ userId, setUser, userParam, appendUser }}>
      {children}
    </UserFilterContext.Provider>
  );
}

export function UserFilterDropdown() {
  const { userId, setUser } = useUserFilter();
  const { data } = useSWR<{ success: boolean; users: User[] }>("/api/users");
  const users = data?.users || [];

  return (
    <select
      value={userId}
      onChange={(e) => setUser(e.target.value)}
      className="bg-background border border-border text-foreground text-xs px-2 py-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
    >
      <option value="">All Users</option>
      <option value="unowned">Unowned</option>
      {users.map((u) => (
        <option key={u.id} value={String(u.id)}>
          {u.name}
        </option>
      ))}
    </select>
  );
}
