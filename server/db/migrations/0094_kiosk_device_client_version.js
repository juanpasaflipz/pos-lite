export const version = 94;
export const name = 'kiosk_device_client_version';

// Which build each kiosk device is actually running.
//
// Web and iPad kiosks pick up a deploy on reload, so their version is
// self-healing. The Android APK bundles its assets at build time and is frozen
// until someone runs `npm run android:install` — a tablet can sit two releases
// behind with nothing on screen to say so. Recording the build each device
// reports on its heartbeat is what makes that visible instead of discovered
// during service.
//
// kiosk_devices already has RLS + app_user grants from pg-schema.sql; adding a
// column inherits both, so there's nothing extra to grant here.
export async function up(sql) {
  await sql`
    ALTER TABLE kiosk_devices
    ADD COLUMN IF NOT EXISTS client_version TEXT
  `;
  await sql`
    ALTER TABLE kiosk_devices
    ADD COLUMN IF NOT EXISTS client_platform TEXT
  `;
}
