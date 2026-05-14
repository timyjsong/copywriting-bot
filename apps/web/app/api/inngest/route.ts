import { serve } from "inngest/next";
import { inngest } from "@copywriting-bot/inngest/client";
import { allFunctions } from "@copywriting-bot/inngest/functions";

export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...allFunctions],
});
