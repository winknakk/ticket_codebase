import { FastifyInstance } from "fastify";
import { z } from "zod";

import { CentralAuthService, CenterTwoFactorRequiredError } from "../../services/CentralAuthService";
import { getSessionTokenService } from "../../middleware/auth";
import { SessionTokenService } from "../../infrastructure/security/SessionTokenService";
import { config } from "../../config/env";
import { OperatorPrincipalResolver } from "../../infrastructure/security/OperatorPrincipalResolver";
import { verifyPassword } from "../../infrastructure/security/PasswordHasher";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { JwtUtil } from "../../shared/jwt";
import { createLogger } from "../../observability/logger";

const logger = createLogger("auth-routes");

const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  otp: z.string().optional(),
  // Which second factor the code answers, and the reference Center issued with
  // the challenge. An authenticator code needs neither; an emailed or texted
  // code is rejected without the ref.
  method: z.enum(["totp", "email", "sms"]).optional(),
  ref: z.string().optional(),
});

const CenterTokenSchema = z.object({
  token: z.string(),
});

const CenterOrgReqSchema = z.object({
  token: z.string(),
  orgId: z.string(),
});

const CompleteCenterLoginSchema = z.object({
  token: z.string(),
  orgId: z.string().optional(),
});

const AddCenterRoleSchema = z.object({
  token: z.string(),
  orgId: z.string(),
  email: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  username: z.string().optional(),
  type: z.string().default("user"),
  head: z.string().optional(),
  position_name: z.string().optional(),
});

const CreateCenterOrgSchema = z.object({
  token: z.string(),
  org_name: z.string(),
  description: z.string().optional(),
  org_department_code: z.string().optional(),
  app_id: z.string().optional(),
  initialManager: z
    .object({
      email: z.string(),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      position_name: z.string().optional(),
    })
    .optional(),
});

export async function registerAuthRoutes(fastify: FastifyInstance) {
  const centralAuthService = new CentralAuthService();
  const principalResolver = new OperatorPrincipalResolver();
  const sessionTokens = getSessionTokenService();

  // 1. Center Login Proxy
  fastify.post("/api/v1/auth/center-login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }

    const { username, password, otp, method, ref } = parseResult.data;

    try {
      const centerRes = await centralAuthService.loginToCenter(username, password, {
        code: otp || "",
        method,
        ref,
      });
      const token = centerRes.token || centerRes.access_token || "";
      const idToken = centerRes.IDToken || centerRes.id_token || "";
      const profile = centralAuthService.parseCenterJwt(token, idToken);

      return reply.send({
        success: true,
        token: centerRes.token || centerRes.access_token,
        profile,
        centerResponse: centerRes,
      });
    } catch (err: any) {
      // Center asking for a second factor is not a failed login. It is answered
      // with the challenge — which method, and the reference a delivered code
      // has to be submitted with — so the client can prompt for the right thing
      // instead of inferring it from the wording of an error message.
      if (err instanceof CenterTwoFactorRequiredError) {
        const { method: challengeMethod, ref: challengeRef } = err.challenge;
        if (challengeMethod === "email" || challengeMethod === "sms") {
          // Center names the factor but does not deliver the code.
          await centralAuthService.sendCenterOtp(username, challengeMethod);
        }
        return reply.status(401).send({
          success: false,
          error: "Center Two-Factor Required",
          twoFactorRequired: true,
          method: challengeMethod,
          ref: challengeRef,
          is2FaHint: true,
          message: "กรุณากรอกรหัสยืนยันตัวตน",
        });
      }

      return reply.status(401).send({
        success: false,
        error: "Center Authentication Failed",
        message: err.message,
        is2FaHint: false,
      });
    }
  });

  // 2. Parse existing Center JWT token
  fastify.post("/api/v1/auth/parse-center-token", async (request, reply) => {
    const body = CenterTokenSchema.parse(request.body);
    const profile = centralAuthService.parseCenterJwt(body.token);

    return reply.send({
      success: true,
      profile,
    });
  });

  // 3. Find Orgs By User (Center CM Service)
  fastify.post("/api/v1/auth/center/find-orgs", async (request, reply) => {
    try {
      const body = CenterTokenSchema.parse(request.body);
      const orgs = await centralAuthService.findOrgsByUser(body.token);
      return reply.send({ success: true, orgs });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token or re-login."
          : (msg || "Failed to fetch Center organizations"),
        isAuthError,
      });
    }
  });

  // 4. Get My Role (Center CM Service)
  fastify.post("/api/v1/auth/center/get-my-role", async (request, reply) => {
    try {
      const body = CenterOrgReqSchema.parse(request.body);
      const role = await centralAuthService.getMyRole(body.token, body.orgId);
      return reply.send({ success: true, role });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token."
          : (msg || "Failed to fetch role from Center"),
        isAuthError,
      });
    }
  });

  // 5. Get User Roles in Org (Center CM Service)
  fastify.post("/api/v1/auth/center/get-user-roles", async (request, reply) => {
    try {
      const body = CenterOrgReqSchema.parse(request.body);
      const roles = await centralAuthService.getUserRoles(body.token, body.orgId);
      return reply.send({ success: true, roles });
    } catch (err: any) {
      const msg = err.message || '';
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("status: 401") || msg.includes("status: 403");
      return reply.send({
        success: false,
        error: isAuthError
          ? "Center session token expired or unauthorized. Please update your token."
          : (msg || "Failed to fetch user roles from Center"),
        isAuthError,
      });
    }
  });

  // 6. Add / Assign Role on Center CM Service
  fastify.post("/api/v1/auth/center/add-role", async (request, reply) => {
    try {
      const body = AddCenterRoleSchema.parse(request.body);
      const result = await centralAuthService.addRoleToCenter(body.token, body);
      return reply.send(result);
    } catch (err: any) {
      const isAuthError = err.message?.includes("401") || err.message?.includes("Unauthorized");
      return reply.send({
        success: false,
        error: err.message || "Failed to add role on Center CM Service",
        isAuthError,
      });
    }
  });

  // 7. Create New Organization on Center CM Service
  fastify.post("/api/v1/auth/center/create-org", async (request, reply) => {
    try {
      const body = CreateCenterOrgSchema.parse(request.body);
      const result = await centralAuthService.createOrgOnCenter(body.token, body);
      return reply.send(result);
    } catch (err: any) {
      const isAuthError = err.message?.includes("401") || err.message?.includes("Unauthorized");
      return reply.send({
        success: false,
        error: err.message || "Failed to create organization on Center CM Service",
        isAuthError,
      });
    }
  });

  // 6. Complete Center Login (Token + Org & Role Resolution)
  fastify.post("/api/v1/auth/center/complete-login", async (request, reply) => {
    try {
      const body = CompleteCenterLoginSchema.parse(request.body);
      const { token } = body;
      const idToken = (request.body as any)?.idToken || (request.body as any)?.IDToken || "";
      const profile = centralAuthService.parseCenterJwt(token, idToken);

      // Attempt to resolve orgId if not provided
      let effectiveOrgId = body.orgId || profile.orgId;
      let userOrgs: any[] = [];
      try {
        userOrgs = await centralAuthService.findOrgsByUser(token);
        if (!body.orgId && userOrgs.length > 0 && userOrgs[0].id) {
          effectiveOrgId = userOrgs[0].id;
        }
      } catch (e) {
        // Fallback to parsed orgId from JWT
      }

      // Attempt to fetch My Role from Center CM Service
      let myRole = null;
      if (effectiveOrgId) {
        try {
          myRole = await centralAuthService.getMyRole(token, effectiveOrgId);
          if (myRole) {
            profile.firstname = myRole.firstname || profile.firstname;
            profile.lastname = myRole.lastname || profile.lastname;
            profile.iam2_id = myRole.iam2_id;
            profile.position_name = myRole.position_name;
            profile.type = myRole.type;
            if (myRole.firstname || myRole.lastname) {
              profile.name = `${myRole.firstname} ${myRole.lastname}`.trim();
            }
          }
        } catch (e) {
          // Non-blocking fallback
        }
      }

      profile.orgId = effectiveOrgId;

      // Exchange the verified Center identity for a TicketX session token.
      // Center proves who the user is; TicketX provisions and scopes the operator record.
      let sessionToken: string | undefined;
      let sessionExpiresAt: string | undefined;
      const tokenService = getSessionTokenService() || (config.SESSION_SECRET ? new SessionTokenService(config.SESSION_SECRET, config.SESSION_TTL_HOURS) : null);

      if (tokenService && profile.email) {
        const cleanEmail = profile.email.trim().toLowerCase();
        let operator = await principalResolver.findOperatorByEmail(cleanEmail);

        if (!operator) {
          // Center identity is verified by Center IAM. Auto-provision operator record in database.
          const cleanRole = (profile.role && ['super_admin', 'admin', 'manager', 'agent', 'employee'].includes(profile.role.toLowerCase()))
            ? profile.role.toLowerCase()
            : 'admin';

          const nextOpRes = await pool.query(
            "SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM operators"
          );
          const nextId = String(nextOpRes.rows[0]?.next_id || Date.now());

          await pool.query(
            `INSERT INTO operators (id, email, password_hash, role, is_active, created_at, updated_at)
             VALUES ($1, $2, 'center_managed_oauth', $3, true, NOW(), NOW())
             ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, is_active = true, updated_at = NOW()`,
            [nextId, cleanEmail, cleanRole]
          ).catch((e: any) => logger.warn({ error: e.message }, "Operator upsert non-blocking warning"));

          operator = await principalResolver.findOperatorByEmail(cleanEmail);
        }

        // Ensure user_roles has active mapping for effectiveOrgId
        if (effectiveOrgId && cleanEmail) {
          const roleId = `role_${cleanEmail.replace(/[^a-zA-Z0-9]/g, '_')}`;
          await pool.query(
            `INSERT INTO user_roles (id, user_email, role, org_id, status, created_at)
             VALUES ($1, $2, $3, $4, 'active', NOW())
             ON CONFLICT (user_email) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, status = 'active'`,
            [roleId, cleanEmail, operator?.role || 'admin', effectiveOrgId]
          ).catch((e: any) => logger.warn({ error: e.message }, "User role upsert non-blocking warning"));
        }

        if (operator) {
          try {
            const principal = await principalResolver.buildPrincipal(operator);
            const issued = tokenService.issue(principal);
            sessionToken = issued.token;
            sessionExpiresAt = issued.expiresAt;
          } catch (err: any) {
            logger.warn(
              { email: profile.email, code: err.code },
              "Principal resolver build failed, issuing fallback Center-scoped session token"
            );
            const fallbackPrincipal: any = {
              kind: "operator" as const,
              subject: String(operator.id),
              email: operator.email,
              role: (operator.role || 'admin') as any,
              orgId: effectiveOrgId || "org_avalant",
              projectIds: null,
            };
            const issued = tokenService.issue(fallbackPrincipal);
            sessionToken = issued.token;
            sessionExpiresAt = issued.expiresAt;
          }
        }

        if (!sessionToken) {
          const fallbackPrincipal: any = {
            kind: "operator" as const,
            subject: String(operator?.id || "3490"),
            email: cleanEmail,
            role: "admin" as any,
            orgId: effectiveOrgId || "org_avalant",
            projectIds: null,
          };
          const issued = tokenService.issue(fallbackPrincipal);
          sessionToken = issued.token;
          sessionExpiresAt = issued.expiresAt;
        }
      }

      return reply.send({
        success: true,
        token,
        sessionToken,
        expiresAt: sessionExpiresAt,
        profile,
        orgs: userOrgs,
        myRole,
      });
    } catch (err: any) {
      return reply.status(401).send({ error: "Center Login Completion Failed", message: err.message });
    }
  });

  /**
   * Customer Sign-in / Verification Ingress
   * POST /api/v1/auth/customer-login
   */
  fastify.post("/api/v1/auth/customer-login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }
    const { username } = parseResult.data;
    const cleanUser = username.trim().toLowerCase();

    // This route verifies no password. It reads a profile and mints a 24-hour
    // portal token, so it is a demo affordance and nothing more — off unless
    // someone has explicitly asked for it, and refused outright in production
    // (env.ts fails the boot if the flag is set there).
    if (!config.ALLOW_DEMO_LOGIN) {
      logger.warn({ username: cleanUser, ip: request.ip }, "Demo customer login attempted while ALLOW_DEMO_LOGIN is off");
      return reply.status(401).send({ error: "Invalid customer account" });
    }

    // Matched on email only. This used to also match `id::text = $1`, and to
    // fall back to profile 101 for any username containing "win" or
    // "customer" — so an arbitrary string was enough to be issued somebody
    // else's token.
    const profRes = await pool.query(
      "SELECT id, name, email, phone, company_id FROM profiles WHERE LOWER(email) = $1 LIMIT 1",
      [cleanUser]
    );

    const customerProfile = profRes.rows[0];
    if (!customerProfile) {
      return reply.status(401).send({ error: "Invalid customer account" });
    }

    const identRes = await pool.query(
      "SELECT channel_ref FROM identities WHERE profile_id::text = $1::text LIMIT 1",
      [String(customerProfile.id)]
    );
    const channelRef = identRes.rows[0]?.channel_ref || `cust_${customerProfile.id}`;

    const { getWebchatJwtSecret } = await import("../../middleware/customerAuth");
    const jwtSecret = getWebchatJwtSecret();
    const proofToken = JwtUtil.sign({
      customerId: channelRef,
      name: customerProfile.name,
      email: customerProfile.email,
    }, jwtSecret, 86400);

    return reply.send({
      success: true,
      role: "customer",
      proofToken,
      customer: {
        id: customerProfile.id,
        name: customerProfile.name,
        email: customerProfile.email,
      }
    });
  });

  // 7. Fallback Local Login
  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const parseResult = LoginSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: "Invalid login payload" });
    }
    if (!sessionTokens) {
      return reply.status(503).send({
        error: "Service Unavailable",
        message: "Session authentication is not configured (SESSION_SECRET missing)",
      });
    }

    const { username, password } = parseResult.data;
    const cleanUser = username.trim().toLowerCase();

    // Customer accounts, which carry no password.
    //
    // This branch returned a token without ever consulting `password`. The
    // condition was a substring test on the username, and the query carried
    // `OR id::text = '101'`, so it matched whatever was sent: posting
    // {"username":"customer","password":"anything"} was a valid sign-in to the
    // customer portal. It is now behind the demo flag, and the profile has to
    // actually match the address given.
    if (config.ALLOW_DEMO_LOGIN && cleanUser.includes("customer")) {
      const profRes = await pool.query(
        "SELECT id, name, email, phone, company_id FROM profiles WHERE LOWER(email) = $1 LIMIT 1",
        [cleanUser]
      );
      if (profRes.rows.length > 0) {
        const customerProfile = profRes.rows[0];
        const identRes = await pool.query(
          "SELECT channel_ref FROM identities WHERE profile_id::text = $1::text LIMIT 1",
          [String(customerProfile.id)]
        );
        const channelRef = identRes.rows[0]?.channel_ref || `cust_${customerProfile.id}`;
        const { getWebchatJwtSecret } = await import("../../middleware/customerAuth");
        const jwtSecret = getWebchatJwtSecret();
        const proofToken = JwtUtil.sign({
          customerId: channelRef,
          name: customerProfile.name,
          email: customerProfile.email,
        }, jwtSecret, 86400);

        logger.info({ customerId: customerProfile.id, email: customerProfile.email }, "Customer signed in via local login");

        return reply.send({
          success: true,
          role: "customer",
          token: proofToken,
          proofToken,
          expiresAt: Date.now() + 86400 * 1000,
          user: {
            username: customerProfile.email,
            email: customerProfile.email,
            name: customerProfile.name,
            role: "customer",
            orgId: "org_avalant",
            projectIds: [1],
          }
        });
      }
    }

    const operator = await principalResolver.findOperatorByEmail(username);
    if (!operator) {
      // Same response as a wrong password: do not disclose which accounts exist.
      return reply.status(401).send({ error: "Invalid username or password" });
    }

    const passwordOk = await verifyPassword(password, operator.passwordHash);
    if (!passwordOk) {
      logger.warn({ email: username, ip: request.ip }, "Failed operator login");
      return reply.status(401).send({ error: "Invalid username or password" });
    }

    // If account has role 'customer', issue Customer Portal token instead of rejecting with 403
    if (operator.role === 'customer') {
      const profRes = await pool.query(
        "SELECT id, name, email, phone, company_id FROM profiles WHERE LOWER(email) = $1 ORDER BY id ASC LIMIT 1",
        [cleanUser]
      );
      const customerProfile = profRes.rows[0];
      const identRes = await pool.query(
        "SELECT channel_ref, org_id FROM identities WHERE profile_id::text = $1::text LIMIT 1",
        [String(customerProfile?.id || operator.id)]
      );
      const channelRef = identRes.rows[0]?.channel_ref || `cust_${customerProfile?.id || operator.id}`;
      const orgId = identRes.rows[0]?.org_id || "org_excise";

      const projRes = await pool.query(
        "SELECT project_id FROM profile_projects WHERE profile_id::text = $1::text",
        [String(customerProfile?.id || operator.id)]
      );
      const projectIds = projRes.rows.map((r: any) => Number(r.project_id)).filter((n: number) => Number.isInteger(n));

      const { getWebchatJwtSecret } = await import("../../middleware/customerAuth");
      const jwtSecret = getWebchatJwtSecret();
      const proofToken = JwtUtil.sign({
        customerId: channelRef,
        name: customerProfile?.name || 'คุณวิน (ลูกค้า)',
        email: operator.email,
        companyId: String(customerProfile?.company_id || 101),
        projectId: String(projectIds[0] || 101),
      }, jwtSecret, 86400);

      logger.info({ email: operator.email }, "Customer signed in via verified password");

      return reply.send({
        success: true,
        role: "customer",
        token: proofToken,
        proofToken,
        expiresAt: Date.now() + 86400 * 1000,
        user: {
          username: operator.email,
          email: operator.email,
          name: customerProfile?.name || 'คุณวิน (ลูกค้า)',
          role: "customer",
          orgId,
          companyId: customerProfile?.company_id || 101,
          projectIds: projectIds.length > 0 ? projectIds : [101],
        }
      });
    }

    let principal;
    try {
      principal = await principalResolver.buildPrincipal(operator);
    } catch (err: any) {
      logger.warn({ email: username, code: err.code }, "Operator authenticated but refused a session");
      return reply.status(403).send({ error: "Forbidden", message: err.message, code: err.code });
    }

    const { token, expiresAt } = sessionTokens.issue(principal);
    await pool
      .query(`UPDATE operators SET last_login_at = NOW() WHERE id = $1`, [operator.id])
      .catch((err: any) => logger.warn({ error: err.message }, "Could not record last_login_at"));

    logger.info({ operatorId: principal.subject, role: principal.role, orgId: principal.orgId }, "Operator signed in");

    return reply.send({
      success: true,
      token,
      expiresAt,
      user: {
        username: operator.email,
        email: operator.email,
        name: operator.email.split("@")[0],
        role: principal.role,
        orgId: principal.orgId,
        projectIds: principal.projectIds,
      },
    });
  });

  /**
   * Returns the caller's own session. Unlike the previous implementation this
   * verifies the presented token instead of unconditionally reporting an
   * authenticated super_admin.
   */
  fastify.get("/api/v1/auth/me", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const principal = sessionTokens && token ? sessionTokens.verify(token) : null;

    if (!principal) {
      return reply.status(401).send({ authenticated: false });
    }

    return reply.send({
      authenticated: true,
      user: {
        username: principal.email,
        email: principal.email,
        role: principal.role,
        orgId: principal.orgId,
        projectIds: principal.projectIds,
      },
    });
  });
}

