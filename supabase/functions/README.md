# Edge functions (source of truth for what is deployed)

| Folder | Deployed slug | What it does | Schedule |
|---|---|---|---|
| `smooth-responder/` | `smooth-responder` | Scheduled **Purge**: at `settings.next_purge_at`, last place in every division is purged | external cron |
| `rapid-processor/` | `rapid-processor` (name `process-waivers`) | **Waivers**: processes claims once `settings.waiver_deadline` has passed | external cron, ~every 10 min |

Both run with the service role key and `verify_jwt = false` (the cron calls them without a user JWT).

Deploy (Supabase dashboard → Edge Functions → the function → Code → paste `index.ts` → Deploy,
or the CLI: `supabase functions deploy <slug> --no-verify-jwt --project-ref viuqdxzzrocofkzadxbx`).
