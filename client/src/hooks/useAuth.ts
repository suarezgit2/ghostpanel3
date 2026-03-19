import { useState, useEffect } from "react";

interface AuthState {
  authenticated: boolean;
  loading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ authenticated: false, loading: true });

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/status", { credentials: "include" });
      const data = await res.json() as { authenticated: boolean };
      setState({ authenticated: data.authenticated, loading: false });
    } catch {
      setState({ authenticated: false, loading: false });
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch { /* ignore */ }
    setState({ authenticated: false, loading: false });
  }

  function onLoginSuccess() {
    setState({ authenticated: true, loading: false });
  }

  return { ...state, logout, onLoginSuccess, checkAuth };
}
