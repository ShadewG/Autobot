"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useAuth } from "./auth-provider";

interface UserFilterContextValue {
  userId: string;
  setUser: (id: string) => void;
  userParam: string;
  appendUser: (url: string) => string;
}

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
  const { user } = useAuth();
  const userId = user ? String(user.id) : "";
  const userParam = userId ? `user_id=${userId}` : "";

  const appendUser = (url: string) => {
    if (!userId) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}user_id=${userId}`;
  };

  return (
    <UserFilterContext.Provider
      value={{ userId, setUser: () => {}, userParam, appendUser }}
    >
      {children}
    </UserFilterContext.Provider>
  );
}
