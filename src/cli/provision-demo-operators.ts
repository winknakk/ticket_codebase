/**
 * Creates the demo console accounts and sets their passwords.
 *
 *   npx tsx src/cli/provision-demo-operators.ts --demo [--project <id>]
 *
 * Why this exists: migration 029_seed_demo_accounts_and_orgs.sql seeds
 * superadmin@ticketx.io, admin@avalant.co.th, agent@avalant.co.th and
 * customer@avalant.co.th into `user_roles` only. `user_roles` maps an email to
 * an organization; it is not the login table. `operators` is, and none of those
 * four has a row there — so /api/v1/auth/login answers 401 for every one of
 * them, whatever the password.
 *
 * The documented demo passwords used to work because the login screen granted
 * super_admin locally whenever the backend rejected the credentials. That
 * client-side bypass was removed (see MainframeLandingLogin.tsx), which was
 * correct, and left nothing behind it. This script provides the missing half.
 *
 * Passwords are hashed here at run time and never written to the repository.
 * The script refuses to run against NODE_ENV=production: the --demo passwords
 * are weak by design and belong only in a demo database.
 */
import { pool } from "../adapters/postgres/PostgresAdapter";
import { hashPassword } from "../infrastructure/security/PasswordHasher";

/** Matches OPERATOR_ROLES in OperatorPrincipalResolver — anything else is refused a session. */
type OperatorRole = "super_admin" | "admin" | "manager" | "agent" | "employee";

interface DemoAccount {
  email: string;
  name: string;
  role: OperatorRole;
  password: string;
  /** Roles outside GLOBAL/ORG_WIDE need explicit project grants or they see nothing. */
  needsProjectAccess: boolean;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: "superadmin@ticketx.io",
    name: "Super Admin",
    role: "super_admin",
    password: "admin123",
    // GLOBAL_ROLES: resolveOrgId short-circuits, so no user_roles row is needed.
    needsProjectAccess: false,
  },
  {
    email: "admin@avalant.co.th",
    name: "Avalant Org Admin",
    role: "admin",
    password: "admin123",
    // ORG_WIDE_ROLES: sees every project in its org. The org comes from the
    // user_roles row migration 029 already seeds (org_avalant).
    needsProjectAccess: false,
  },
  {
    email: "agent@avalant.co.th",
    name: "Avalant Support Agent",
    role: "agent",
    password: "agent123",
    needsProjectAccess: true,
  },
  {
    email: "customer.win@ticketx.local",
    name: "คุณวิน (ลูกค้า)",
    role: "employee",
    password: "customer123",
    needsProjectAccess: false,
  },
];

/**
 * customer@avalant.co.th is deliberately absent.
 *
 * Its role is `customer`, which is not in OPERATOR_ROLES, so buildPrincipal
 * would refuse it with 403 ROLE_NOT_PERMITTED even with a correct password.
 * Giving it an operator role to make the login succeed would hand a customer
 * an operator console session. How the customer portal should authenticate is
 * a design decision, not something this script should quietly settle.
 */
const EXCLUDED = "customer@avalant.co.th";

const COMPANY_ID = 1;

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--demo")) {
    console.error("Usage: npx tsx src/cli/provision-demo-operators.ts --demo [--project <id>]");
    console.error("--demo is required, and acknowledges that weak documented passwords will be set.");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run with NODE_ENV=production. These are demo passwords.");
    process.exit(1);
  }

  const projectFlag = args.indexOf("--project");
  const projectId = projectFlag !== -1 ? Number(args[projectFlag + 1]) : null;
  if (projectFlag !== -1 && !Number.isInteger(projectId)) {
    console.error("--project needs an integer project id");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const account of DEMO_ACCOUNTS) {
      const hash = await hashPassword(account.password);
      const nextOpRes = await client.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM operators");
      const nextId = String(nextOpRes.rows[0]?.next_id || Date.now());

      const { rows } = await client.query(
        `INSERT INTO operators (id, company_id, email, name, display_name, role, status, is_active, password_hash, settings)
         VALUES ($1, $2, $3, $4, $4, $5, 'active', TRUE, $6, '{}'::jsonb)
         ON CONFLICT (email) DO UPDATE
            SET role = EXCLUDED.role,
                status = 'active',
                is_active = TRUE,
                password_hash = EXCLUDED.password_hash,
                deleted_at = NULL,
                updated_at = NOW()
         RETURNING id, email, role`,
        [nextId, COMPANY_ID, account.email, account.name, account.role, hash]
      );

      const operator = rows[0];
      console.log(`  ${operator.email.padEnd(26)} role=${String(operator.role).padEnd(12)} id=${operator.id}`);

      if (account.needsProjectAccess) {
        if (projectId === null) {
          console.log(
            `    ! role '${account.role}' is scoped per project and no --project was given.` +
              " It can sign in but will see no conversations."
          );
        } else {
          await client.query(
            `INSERT INTO operator_project_access (operator_id, project_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (operator_id, project_id) DO NOTHING`,
            [operator.id, projectId, account.role]
          );
          console.log(`    granted access to project ${projectId}`);
        }
      }

      // Ensure user_roles mapping exists for org resolution
      const roleId = `role_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}`;
      await client.query(
        `INSERT INTO user_roles (id, user_email, role, org_id, status, created_at)
         VALUES ($1, $2, $3, 'org_avalant', 'active', NOW())
         ON CONFLICT (user_email) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
        [roleId, account.email, account.role]
      ).catch(() => {});

      if (account.email.includes("customer")) {
        // Ensure profile exists for Customer Web App
        const nextProfId = await client.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
        const pid = nextProfId.rows[0]?.next_id || 101;
        await client.query(
          `INSERT INTO profiles (id, name, email, phone, company_id, created_at, updated_at)
           VALUES ($1, $2, $3, '0812345678', 1, NOW(), NOW())
           ON CONFLICT DO NOTHING`,
          [pid, account.name, account.email]
        ).catch(() => {});
        await client.query(
          `INSERT INTO identities (profile_id, channel, channel_ref, created_at)
           VALUES ($1, 'webchat', $2, NOW())
           ON CONFLICT DO NOTHING`,
          [pid, `cust_${account.email.replace(/[^a-zA-Z0-9]/g, '_')}`]
        ).catch(() => {});
      }
    }

    await client.query("COMMIT");
  } catch (err: any) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`\n${DEMO_ACCOUNTS.length} account(s) provisioned. Passwords are the documented demo ones.`);
  console.log(`Skipped ${EXCLUDED}: role 'customer' may not hold an operator session (see the note in this file).`);
  console.log("Rotate or remove these accounts before this database is used for anything real.");

  await pool.end();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
