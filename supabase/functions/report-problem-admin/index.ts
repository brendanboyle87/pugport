import { createProblemReportHandler } from '../_shared/problem-report.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

Deno.serve(
  createProblemReportHandler(
    {
      url: Deno.env.get('SUPABASE_URL')!,
      serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      ownerUserId: Deno.env.get('OWNER_USER_ID'),
    },
    true,
  ),
);
