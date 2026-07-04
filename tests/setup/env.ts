import dotenv from 'dotenv';
import path from 'node:path';

// Load .env.test into process.env BEFORE any server/* module reads DATABASE_URL.
// Vitest calls setupFiles before the test module imports, so this runs first.
dotenv.config({ path: path.resolve(process.cwd(), '.env.test'), override: true });

// Safety guard: refuse to run against anything other than the known test branch.
// The prod branch has a different endpoint; if DATABASE_URL points at it (via
// a stale .env or a bad copy-paste), abort loudly instead of writing data.
const TEST_BRANCH_HOST_FRAGMENT = 'ep-small-credit-ajz9ppry';
const url = process.env.DATABASE_URL || '';
if (!url.includes(TEST_BRANCH_HOST_FRAGMENT)) {
  throw new Error(
    `[tests] DATABASE_URL does not contain '${TEST_BRANCH_HOST_FRAGMENT}'. ` +
    `Refusing to run — this would risk writing to a non-test database. ` +
    `Ensure .env.test exists and points at the Neon test branch.`,
  );
}
