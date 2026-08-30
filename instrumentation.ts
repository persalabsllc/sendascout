import type { Instrumentation } from "next";

export async function register() {}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportException } = await import("@/lib/observability");
  await reportException(error, {
    route: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routeType: context.routeType,
    renderSource: context.renderSource,
  });
};
