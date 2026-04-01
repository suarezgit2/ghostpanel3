import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import { lazy, Suspense } from "react";
import { useAuth } from "./hooks/useAuth";
import { Ghost } from "lucide-react";

// Lazy loading de todas as páginas — cada página só é carregada quando acessada
// Isso reduz o bundle inicial de ~517kb para ~150kb
const Dashboard = lazy(() => import("./pages/Dashboard"));
const CreateJob = lazy(() => import("./pages/CreateJob"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Accounts = lazy(() => import("./pages/Accounts"));
const Proxies = lazy(() => import("./pages/Proxies"));
const Logs = lazy(() => import("./pages/Logs"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const QuickJob = lazy(() => import("./pages/QuickJob"));
const Keys = lazy(() => import("./pages/Keys"));
const ApiDocs = lazy(() => import("./pages/ApiDocs"));
const ApiTokens = lazy(() => import("./pages/ApiTokens"));
const RedeemKey = lazy(() => import("./pages/RedeemKey"));
const OutlookCallback = lazy(() => import("./pages/OutlookCallback"));

// Loading spinner para Suspense
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );
}

function Router({ onLogout }: { onLogout: () => void }) {
  return (
    <DashboardLayout onLogout={onLogout}>
      <Suspense fallback={<PageLoader />}>
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
          <Route path="/settings/outlook-callback" component={OutlookCallback} />
          <Route path="/keys" component={Keys} />
          <Route path="/api-docs" component={ApiDocs} />
          <Route path="/api-tokens" component={ApiTokens} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
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
          ) : window.location.pathname === "/settings/outlook-callback" ? (
            <Suspense fallback={<PageLoader />}>
              <OutlookCallback />
            </Suspense>
          ) : window.location.pathname === "/redeem" ? (
            <Suspense fallback={<PageLoader />}>
              <RedeemKey />
            </Suspense>
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
