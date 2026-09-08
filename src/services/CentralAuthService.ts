import { createLogger } from "../observability/logger";
import { TenantContext, createTenantContext } from "../domain/tenant/TenantContext";
import { ConstantSystemService } from "./ConstantSystemService";

const logger = createLogger("CentralAuthService");

/** Which second factor Center will accept, and the reference tying a code to this login. */
export interface CenterChallenge {
  method: "totp" | "email" | "sms";
  /** null for an authenticator app — only the delivered-code methods carry one. */
  ref: string | null;
}

/** The second factor on a resubmitted login. */
export interface CenterSecondFactor {
  code: string;
  method?: "totp" | "email" | "sms";
  ref?: string | null;
}

/**
 * Not a failure — Center is asking for the second factor. Carried as a distinct
 * type so the route can answer with a challenge instead of "wrong password".
 */
export class CenterTwoFactorRequiredError extends Error {
  readonly challenge: CenterChallenge;
  constructor(challenge: CenterChallenge) {
    super("Center requires a second factor");
    this.name = "CenterTwoFactorRequiredError";
    this.challenge = challenge;
  }
}

/**
 * Read a 2FA challenge out of a Center rejection.
 *
 * Center signals it with `error: "Require TOTP"` and names the factor in
 * `error_description`: empty means the authenticator app, "email:<ref>" an
 * emailed code, and anything else is an SMS reference (optionally prefixed
 * "sms:"). Returns null when the rejection is an ordinary one.
 */
export function parseCenterChallenge(errBody: any): CenterChallenge | null {
  const error = String(errBody?.error ?? "");
  if (error !== "Require TOTP" && error !== "TOTP required but not provided") return null;

  const description = String(errBody?.error_description ?? "");
  if (!description) return { method: "totp", ref: null };
  if (description.startsWith("email:")) {
    return { method: "email", ref: description.slice("email:".length) };
  }
  return { method: "sms", ref: description.startsWith("sms:") ? description.slice("sms:".length) : description };
}

export interface CenterLoginResponse {
  tokenType: string;
  token: string;
  IDToken?: string;
  expiresDate?: string;
  access_token?: string;
  id_token?: string;
}

export interface UserRoleProfile {
  email: string;
  userId: number | string;
  name: string;
  role: "super_admin" | "admin" | "employee" | "customer";
  orgId: string;
  rawAuthorities: string[];
  firstname?: string;
  lastname?: string;
  iam2_id?: string;
  position_name?: string;
  type?: string;
}

export interface CenterOrg {
  id: string;
  org_name?: string;
  description?: string;
  app_id?: string;
  organization_id?: string;
  org_department_code?: string;
  created_by?: string;
  created_date?: string;
}

export interface CenterUserRole {
  email: string;
  firstname: string;
  iam2_id: string;
  id: string;
  lastname: string;
  username: string;
  type: string;
  head?: string;
  position_name?: string;
}

export interface AddCenterRoleRequest {
  orgId: string;
  email: string;
  firstname: string;
  lastname: string;
  username?: string;
  type: string;
  head?: string;
  position_name?: string;
}

export interface CreateCenterOrgRequest {
  org_name: string;
  description?: string;
  org_department_code?: string;
  app_id?: string;
  initialManager?: {
    email: string;
    firstname?: string;
    lastname?: string;
    position_name?: string;
  };
}

export class CentralAuthService {
  private centerAuthUrl: string;

  constructor(centerAuthUrl: string = "https://centerapp.io/center/auth/login") {
    this.centerAuthUrl = centerAuthUrl;
  }

  /**
   * Authenticate directly with the Central IAM Server.
   *
   * Center completes 2FA on this same endpoint — there is no separate verify
   * call — but it is particular about which field the code arrives in, and the
   * fields are not interchangeable:
   *
   *   authenticator app  ->  totp
   *   emailed / texted   ->  otp + otpRef (the ref from the challenge)
   *
   * This used to send the code under five names at once (otp, totp, code,
   * authCode, authenticatorCode) in the hope that one would be the right one.
   * That is why an authenticator code never worked: `otp` present without a
   * valid `otpRef` reads to Center as "an email code was submitted, and its
   * reference is missing", and it rejects the whole login — so the guess that
   * was meant to be harmless was the thing doing the harm.
   */
  async loginToCenter(
    username: string,
    password: string,
    secondFactor?: string | CenterSecondFactor
  ): Promise<CenterLoginResponse> {
    const factor: CenterSecondFactor | undefined =
      typeof secondFactor === "string" ? { code: secondFactor } : secondFactor;

    try {
      const payload: Record<string, any> = {
        username,
        password,
        fcmToken: null,
        deviceID: "5f9b0040-aea9-4496-ac71-8ee2b1119d7b",
        deviceToken: null,
        devicePlatform: "web",
        groupIam2ID: null,
      };

      const code = factor?.code?.trim();
      if (code) {
        // Exactly one shape, chosen by the method the challenge named. An
        // empty otp/otpRef pair is worse than sending nothing, so neither key
        // appears unless it carries a real value.
        if (factor?.method === "email" || factor?.method === "sms") {
          payload.otp = code;
          if (factor.ref) payload.otpRef = factor.ref;
        } else {
          payload.totp = code;
        }
      }

      const res = await fetch(this.centerAuthUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let errBody: any = null;
        try {
          errBody = await res.json();
        } catch {
          // ignore
        }

        // A 2FA-protected account answers a plain password with an error, not
        // a token, and names the second factor in error_description.
        const challenge = parseCenterChallenge(errBody);
        if (challenge) throw new CenterTwoFactorRequiredError(challenge);

        const errMsg = errBody?.error || errBody?.error_description || `Center Auth failed with status: ${res.status}`;
        throw new Error(errMsg);
      }

      const data = (await res.json()) as CenterLoginResponse;
      return data;
    } catch (err: any) {
      if (err instanceof CenterTwoFactorRequiredError) {
        logger.info({ username, method: err.challenge.method }, "Center requires a second factor");
        throw err;
      }
      logger.warn({ error: err.message, username }, "Center Auth network call failed, attempting token parse or fallback");
      throw err;
    }
  }

  /**
   * Ask Center to deliver a one-time code for an email or SMS second factor.
   * Center's challenge names the method but does not send the code; the client
   * has to trigger it before the user has anything to type.
   */
  async sendCenterOtp(username: string, method: "email" | "sms"): Promise<void> {
    const sendCodeUrl = this.centerAuthUrl.replace(/\/login$/, "/sendcode");
    try {
      await fetch(sendCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: username,
          username,
          phoneNumber: "",
          phoneCountry: "",
          isVerifyAccount: false,
          isEmail: method === "email",
        }),
      });
    } catch (err: any) {
      // Best effort: the challenge is still worth returning to the caller, who
      // can offer a resend. Failing the login here would be worse.
      logger.warn({ error: err.message, username, method }, "Center sendcode failed");
    }
  }

  /**
   * Fetch organizations linked to user token from CM Service
   */
  async findOrgsByUser(token: string): Promise<CenterOrg[]> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/find-orgs-byuser`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authToken,
          Accept: "*/*",
        },
      });

      if (!res.ok) {
        throw new Error(`findOrgsByUser failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterOrg[];
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to fetch user orgs from Center CM Service");
      throw err;
    }
  }

  /**
   * Fetch my role for specific orgId from CM Service
   */
  async getMyRole(token: string, orgId: string): Promise<CenterUserRole> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/get-my-role`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId }),
      });

      if (!res.ok) {
        throw new Error(`getMyRole failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterUserRole;
    } catch (err: any) {
      logger.error({ error: err.message, orgId }, "Failed to fetch my role from Center CM Service");
      throw err;
    }
  }

  /**
   * Fetch all user roles for specific orgId from CM Service
   */
  async getUserRoles(token: string, orgId: string): Promise<CenterUserRole[]> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/get-user-roles`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ orgId }),
      });

      if (!res.ok) {
        throw new Error(`getUserRoles failed with status: ${res.status}`);
      }

      return (await res.json()) as CenterUserRole[];
    } catch (err: any) {
      logger.error({ error: err.message, orgId }, "Failed to fetch user roles from Center CM Service");
      throw err;
    }
  }

  /**
   * Add / assign role on Center CM Service
   */
  async addRoleToCenter(token: string, payload: AddCenterRoleRequest): Promise<{ success: boolean; data?: any }> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/add-role`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const bodyPayload = {
        orgId: payload.orgId,
        email: payload.email,
        firstname: payload.firstname,
        lastname: payload.lastname,
        username: payload.username || payload.email,
        type: payload.type || "user",
        head: payload.head || "",
        position_name: payload.position_name || "Member",
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        // Fallback endpoint try /org/save-user-role
        const fallbackUrl = `${baseUrl}/org/save-user-role`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            Authorization: authToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyPayload),
        });
        if (!fallbackRes.ok) {
          throw new Error(`addRoleToCenter failed with status: ${res.status}`);
        }
        return { success: true, data: await fallbackRes.json() };
      }

      return { success: true, data: await res.json() };
    } catch (err: any) {
      logger.error({ error: err.message, payload }, "Failed to add role on Center CM Service");
      throw err;
    }
  }

  /**
   * Create new organization on Center CM Service
   */
  async createOrgOnCenter(token: string, payload: CreateCenterOrgRequest): Promise<{ success: boolean; org?: any; data?: any }> {
    try {
      const baseUrl = await ConstantSystemService.getCenterCmServiceUrl();
      const url = `${baseUrl}/org/create`;
      const authToken = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

      const bodyPayload = {
        org_name: payload.org_name,
        description: payload.description || "",
        org_department_code: payload.org_department_code || "",
        app_id: payload.app_id || "",
      };

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        // Fallback endpoint try /org/save
        const fallbackUrl = `${baseUrl}/org/save`;
        const fallbackRes = await fetch(fallbackUrl, {
          method: "POST",
          headers: {
            Authorization: authToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyPayload),
        });
        if (!fallbackRes.ok) {
          throw new Error(`createOrgOnCenter failed with status: ${res.status}`);
        }
        const createdOrgData = await fallbackRes.json();
        const newOrgId = createdOrgData?.id || createdOrgData?.orgId || createdOrgData?.data?.id;

        // Auto assign initial manager if provided
        if (payload.initialManager?.email && newOrgId) {
          try {
            await this.addRoleToCenter(token, {
              orgId: newOrgId,
              email: payload.initialManager.email,
              firstname: payload.initialManager.firstname || payload.initialManager.email.split('@')[0],
              lastname: payload.initialManager.lastname || '',
              type: 'manager',
              position_name: payload.initialManager.position_name || 'Organization Lead',
            });
          } catch (mgrErr: any) {
            logger.warn({ error: mgrErr.message, orgId: newOrgId }, "Could not auto-assign initial manager to created org");
          }
        }

        return { success: true, org: createdOrgData };
      }

      const createdOrg = await res.json();
      const newOrgId = createdOrg?.id || createdOrg?.orgId || createdOrg?.data?.id;

      // Auto assign initial manager if provided
      if (payload.initialManager?.email && newOrgId) {
        try {
          await this.addRoleToCenter(token, {
            orgId: newOrgId,
            email: payload.initialManager.email,
            firstname: payload.initialManager.firstname || payload.initialManager.email.split('@')[0],
            lastname: payload.initialManager.lastname || '',
            type: 'manager',
            position_name: payload.initialManager.position_name || 'Organization Lead',
          });
        } catch (mgrErr: any) {
          logger.warn({ error: mgrErr.message, orgId: newOrgId }, "Could not auto-assign initial manager to created org");
        }
      }

      return { success: true, org: createdOrg };
    } catch (err: any) {
      logger.error({ error: err.message, payload }, "Failed to create organization on Center CM Service");
      throw err;
    }
  }

  /**
   * Parses and maps JWT claims from Center Auth Response into TicketX UserRoleProfile
   */
  parseCenterJwt(token: string, idToken?: string): UserRoleProfile {
    try {
      let cleanToken = token.trim();
      if (cleanToken.startsWith('"') && cleanToken.endsWith('"')) {
        cleanToken = cleanToken.slice(1, -1).trim();
      }
      if (cleanToken.startsWith("Bearer ")) {
        cleanToken = cleanToken.slice(7).trim();
      }

      const parts = cleanToken.split(".");
      if (parts.length < 2) {
        throw new Error("Invalid JWT token format");
      }

      const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
      const decoded = JSON.parse(payloadJson);

      let decodedIdToken: any = null;
      if (idToken && idToken.includes(".")) {
        try {
          let cleanId = idToken.trim();
          if (cleanId.startsWith("Bearer ")) cleanId = cleanId.slice(7).trim();
          const idParts = cleanId.split(".");
          if (idParts.length >= 2) {
            decodedIdToken = JSON.parse(Buffer.from(idParts[1], "base64").toString("utf-8"));
          }
        } catch (e) {
          // ignore invalid idToken
        }
      }

      const email =
        decoded.email ||
        decoded.user_name ||
        decoded.username ||
        (decoded.sub && decoded.sub.includes("@") ? decoded.sub : "") ||
        decoded.preferred_username ||
        decoded.upn ||
        decoded.claims?.userinfo?.email ||
        decodedIdToken?.email ||
        decodedIdToken?.user_name ||
        decodedIdToken?.username ||
        (decodedIdToken?.sub && decodedIdToken.sub.includes("@") ? decodedIdToken.sub : "") ||
        decodedIdToken?.claims?.userinfo?.email ||
        "operator@avalant.co.th";
      const firstname =
        decoded.firstname ||
        decoded.claims?.userinfo?.given_name ||
        decodedIdToken?.firstname ||
        decodedIdToken?.claims?.userinfo?.given_name ||
        decodedIdToken?.given_name ||
        "";
      const lastname =
        decoded.lastname ||
        decoded.claims?.userinfo?.family_name ||
        decodedIdToken?.lastname ||
        decodedIdToken?.claims?.userinfo?.family_name ||
        decodedIdToken?.family_name ||
        "";
      const name = `${firstname} ${lastname}`.trim() || email;
      const userId = decoded.user_id || decoded.claims?.userinfo?.user_id || decodedIdToken?.claims?.userinfo?.user_id || 1;

      // Extract Authorities / Roles from both access_token and idToken
      const authorities: string[] = Array.isArray(decoded.authorities) ? [...decoded.authorities] : [];
      if (decodedIdToken && Array.isArray(decodedIdToken.authorities)) {
        authorities.push(...decodedIdToken.authorities);
      }

      if (decoded.system_id && typeof decoded.system_id === "object") {
        for (const sysKey of Object.keys(decoded.system_id)) {
          const sysRoles = decoded.system_id[sysKey]?.roles;
          if (Array.isArray(sysRoles)) {
            authorities.push(...sysRoles);
          }
        }
      }

      // Role Mapping Rules (High priority to Low priority)
      let role: "super_admin" | "admin" | "employee" | "customer" = "employee";
      const upperAuths = authorities.map((a) => String(a).toUpperCase());

      if (upperAuths.includes("ROLE_SUPERADMIN") || email.includes("superadmin")) {
        role = "super_admin";
      } else if (upperAuths.includes("ROLE_ADMIN") || upperAuths.includes("ADMIN")) {
        role = "admin";
      } else if (upperAuths.includes("CUSER") || upperAuths.includes("CUSTOMER")) {
        role = "customer";
      } else if (upperAuths.includes("ROLE_USER") || upperAuths.includes("USER") || upperAuths.includes("EMPLOYEE")) {
        role = "employee";
      }

      const orgId = decoded.group_id && Number(decoded.group_id) > 0 ? `org_${decoded.group_id}` : "org_avalant";

      return {
        email,
        userId,
        name,
        role,
        orgId,
        rawAuthorities: authorities,
        firstname,
        lastname,
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to parse Center JWT token");
      return {
        email: "unknown@ticketx.io",
        userId: 0,
        name: "Unknown User",
        role: "employee",
        orgId: "org_default",
        rawAuthorities: [],
      };
    }
  }
}

