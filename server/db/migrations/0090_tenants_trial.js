export const version = 90;
export const name = 'tenants_trial';

// Freemium launch: every new self-serve registration starts with a 14-day
// full-Pro trial (no card), then lands on the free-forever plan. The stored
// plan stays 'free' during the trial — Pro access is computed from
// trial_ends_at (see planLimits.effectivePlan), so expiry needs no job.
// The two *_at columns dedupe the reminder/ended emails sent by
// lib/trialReminders.js.

export async function up(sql) {
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_reminder_sent_at TIMESTAMPTZ`;
  await sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ended_notified_at TIMESTAMPTZ`;
}
