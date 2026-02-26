"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useAuth } from "./auth-provider";

interface UserFilterContextValue {
  userId: string;
  setUser: (id: string) => void;
  userParam: string;
  appendUser: (url: string) => string;
  isAdmin: boolean;
  viewAll: boolean;
  setViewAll: (val: boolean) => void;
}

const UserFilterContext = createContext<UserFilterContextValue>({
  userId: "",
  setUser: () => {},
  userParam: "",
  appendUser: (url) => url,
  isAdmin: false,
  viewAll: false,
  setViewAll: () => {},
});

export function useUserFilter() {
  return useContext(UserFilterContext);
}

export function UserFilterProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const [viewAll, setViewAll] = useState(isAdmin); // admins default to view-all
  const userId = user ? String(user.id) : "";

  // When admin has viewAll on, don't append user_id filter
  const shouldFilter = userId && !(isAdmin && viewAll);
  const userParam = shouldFilter ? `user_id=${userId}` : "";

  const appendUser = (url: string) => {
    if (!shouldFilter) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}user_id=${userId}`;
  };

  return (
    <UserFilterContext.Provider
      value={{ userId, setUser: () => {}, userParam, appendUser, isAdmin, viewAll, setViewAll }}
    >
      {children}
    </UserFilterContext.Provider>
  );
}
