// Shared HTTP helpers for every route module.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ConflictError, NotFoundError } from "./repo.ts";

/** Router with a validation hook that answers 400 with readable zod issues. Use it for every route module. */
export function createRouter() {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "invalid_request", message: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") },
          400,
        );
      }
    },
  });
}

/** Maps domain errors to HTTP. Registered on the root app; sub-routers inherit it. */
export function errorResponse(err: Error, c: Context) {
  if (err instanceof NotFoundError) return c.json({ error: "not_found", message: err.message }, 404);
  if (err instanceof ConflictError) return c.json({ error: "conflict", message: err.message }, 409);
  if ("status" in err && err.status === 403) return c.json({ error: "forbidden", message: err.message }, 403);
  if ("status" in err && typeof err.status === "number" && err.status >= 400 && err.status < 500) {
    return c.json({ error: "bad_request", message: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: "internal", message: err.message }, 500);
}
