/* Cadence ⇄ Supabase — public client config. Loaded by pages that need the
   accounts layer (sign-in, synced favorites, alert preferences, claims).

   These values are PUBLIC by design: the publishable key is meant to ship in
   browser JS, and every table is protected by Postgres row-level security —
   never by hiding this key. The service-role key must NEVER appear in this
   repo or in any client code. */
window.CAD_SUPABASE = {
  url: "https://srpqgbkodcrroobuksty.supabase.co",
  publishableKey: "sb_publishable_s99nnQ-uEXDnWED8Njr8OA_aZgMpMDz",
};
