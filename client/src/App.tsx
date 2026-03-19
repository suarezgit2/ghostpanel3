import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import CreateJob from "./pages/CreateJob";
import Jobs from "./pages/Jobs";
import Accounts from "./pages/Accounts";
import Proxies from "./pages/Proxies";
import Logs from "./pages/Logs";
import SettingsPage from "./pages/SettingsPage";
import JobDetail from "./pages/JobDetail";
import QuickJob from "./pages/QuickJob";
import Keys from "./pages/Keys";
import ApiDocs from "./pages/ApiDocs";
import ApiTokens from "./pages/ApiTokens";
import RedeemKey from "./pages/RedeemKey";
import { useAuth } from "./hooks/useAuth";
import { Ghost } from "lucide-react";
function Router({ onLogout }: { onLogout: () => void }) {
  return (
    <DashboardLayout onLogout={onLogout}>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/create" component={CreateJob} />
        <Route path="/quick-job" component={QuickJob} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/proxies" component={Proxies} />
        <Route path="/logs" component={Logs} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/keys" component={Keys} />
        <Route path="/api-docs" component={ApiDocs} />
        <Route path="/api-tokens" component={ApiTokens} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function App() {
  const { authenticated, loading, logout, onLoginSuccess } = useAuth();

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster
            theme="dark"
            toastOptions={{
              style: {
                background: "oklch(0.175 0.005 286)",
                border: "1px solid oklch(1 0 0 / 8%)",
                color: "oklch(0.93 0.005 286)",
              },
            }}
          />
          {loading ? (
            <div className="min-h-screen flex items-center justify-center bg-background">
              <div className="flex flex-col items-center gap-3">
                <Ghost className="w-10 h-10 text-primary animate-pulse" />
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            </div>
          ) : window.location.pathname === "/redeem" ? (
            <RedeemKey />
          ) : authenticated ? (
            <Router onLogout={logout} />
          ) : (
            <Login onSuccess={onLoginSuccess} />
          )}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
