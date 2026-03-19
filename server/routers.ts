import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { dashboardRouter } from "./routers/dashboard";
import { jobsRouter } from "./routers/jobs";
import { accountsRouter } from "./routers/accounts";
import { proxiesRouter } from "./routers/proxies";
import { logsRouter } from "./routers/logs";
import { settingsRouter } from "./routers/settings";
import { keysRouter } from "./routers/keys";
import { apiTokensRouter } from "./routers/apiTokens";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // Ghost feature routers
  dashboard: dashboardRouter,
  jobs: jobsRouter,
  accounts: accountsRouter,
  proxies: proxiesRouter,
  logs: logsRouter,
  settings: settingsRouter,
  keys: keysRouter,
  apiTokens: apiTokensRouter,
});

export type AppRouter = typeof appRouter;
