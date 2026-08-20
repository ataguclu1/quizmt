import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import LoginPage from "@/pages/LoginPage";
import AdminPage from "@/pages/AdminPage";
import FullUserPage from "@/pages/FullUserPage";
import LimitedUserPage from "@/pages/LimitedUserPage";
import PlayerPage from "@/pages/PlayerPage";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function AuthenticatedRouter() {
  const { user } = useAuth();

  if (!user) {
    return <LoginPage />;
  }

  if (user.role === "admin") return <AdminPage />;
  if (user.role === "full") return <FullUserPage />;
  if (user.role === "limited") return <LimitedUserPage />;
  return <LoginPage />;
}

function Router() {
  return (
    <Switch>
      <Route path="/join" component={PlayerPage} />
      <Route path="/" component={AuthenticatedRouter} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
