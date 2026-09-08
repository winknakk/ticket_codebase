import { IMediaStorageService } from "./IMediaStorageService";
import { UploadMediaOptions, UploadMediaResult } from "../types/mediaStorage.types";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface S3Config {
  endpoint?: string;
  bucketName?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  localVaultPath?: string;
  publicCdnBaseUrl?: string;
  signingSecret?: string;
}

export class S3MediaStorageService implements IMediaStorageService {
  private bucketName: string;
  private localVaultPath: string;
  private publicCdnBaseUrl: string;
  private signingSecret: string;

  constructor(config: S3Config) {
    this.bucketName = config.bucketName || "automationx-media";
    this.localVaultPath = path.resolve(config.localVaultPath || path.join(__dirname, "../../../uploads"));
    this.publicCdnBaseUrl = config.publicCdnBaseUrl || "http://localhost:3000/api/v1/media";
    this.signingSecret = config.signingSecret ||
      process.env.MEDIA_SIGNING_SECRET ||
      process.env.JWT_SECRET ||
      "automationx-development-media-secret";

    if (process.env.NODE_ENV === "production" &&
        !config.signingSecret &&
        !process.env.MEDIA_SIGNING_SECRET &&
        !process.env.JWT_SECRET) {
      console.warn("⚠️ [S3MediaStorageService] MEDIA_SIGNING_SECRET or JWT_SECRET is not set in production. Using fallback secret.");
    }

    if (!fs.existsSync(this.localVaultPath)) {
      fs.mkdirSync(this.localVaultPath, { recursive: true });
    }
  }

  async upload(options: UploadMediaOptions): Promise<UploadMediaResult> {
    const fileHash = crypto.createHash("md5").update(options.buffer).digest("hex").slice(0, 10);
    const datePrefix = new Date().toISOString().slice(0, 7).replace("-", "/"); // e.g. 2026/07
    const ext = path.extname(options.fileName) || this.getExtensionFromMime(options.mimeType);
    const safeName = path.basename(options.fileName, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    
    const folder = (options.folder || datePrefix).replace(/\\/g, "/");
    const storageKey = this.normalizeStorageKey(`${folder}/${safeName}_${fileHash}${ext}`);

    const fullPath = this.resolveStoragePath(storageKey);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, options.buffer);

    const fileUrl = await this.generatePresignedUrl(storageKey, 900);

    return {
      storageKey,
      fileUrl,
      fileName: options.fileName,
      fileType: options.mimeType,
      fileSize: options.buffer.length
    };
  }

  async download(storageKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const normalizedStorageKey = this.normalizeStorageKey(storageKey);
    const fullPath = this.resolveStoragePath(normalizedStorageKey);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Media file not found for key: ${normalizedStorageKey}`);
    }

    const buffer = await fs.promises.readFile(fullPath);
    const ext = path.extname(normalizedStorageKey).toLowerCase();
    let mimeType = this.getMimeFromExtension(ext);
    if (buffer.toString("utf-8", 0, 50).includes("<svg")) {
      mimeType = "image/svg+xml";
    }

    return { buffer, mimeType };
  }


  async generatePresignedUrl(storageKey: string, expiresInSeconds: number = 900): Promise<string> {
    const normalizedStorageKey = this.normalizeStorageKey(storageKey);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = this.createSignature(normalizedStorageKey, expiresAt);

    return `${this.publicCdnBaseUrl}/file?key=${encodeURIComponent(normalizedStorageKey)}&expires=${expiresAt}&signature=${token}`;
  }

  async generateDirectUploadUrl(storageKey: string, expiresInSeconds: number = 3600): Promise<string> {
    const normalizedStorageKey = this.normalizeStorageKey(storageKey);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = this.createSignature(normalizedStorageKey, expiresAt);

    const baseUrl = this.publicCdnBaseUrl.replace(/\/api\/v1\/media\/?$/, "");
    return `${baseUrl}/api/v1/webchat/upload/direct?key=${encodeURIComponent(normalizedStorageKey)}&expires=${expiresAt}&signature=${token}`;
  }

  async saveBuffer(storageKey: string, buffer: Buffer): Promise<void> {
    const normalizedStorageKey = this.normalizeStorageKey(storageKey);
    const fullPath = this.resolveStoragePath(normalizedStorageKey);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(fullPath, buffer);
  }

  verifyPresignedUrl(storageKey: string, expires: string | number, signature: string): boolean {
    let normalizedStorageKey: string;
    try {
      normalizedStorageKey = this.normalizeStorageKey(storageKey);
    } catch {
      return false;
    }

    const expiresAt = Number(expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return false;
    }

    if (!/^[a-f0-9]{64}$/i.test(signature)) {
      return false;
    }

    const expected = Buffer.from(this.createSignature(normalizedStorageKey, expiresAt), "hex");
    const actual = Buffer.from(signature, "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      return fs.existsSync(this.resolveStoragePath(this.normalizeStorageKey(storageKey)));
    } catch {
      return false;
    }
  }

  async delete(storageKey: string): Promise<void> {
    const fullPath = this.resolveStoragePath(this.normalizeStorageKey(storageKey));
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  private createSignature(storageKey: string, expiresAt: number): string {
    return crypto
      .createHmac("sha256", this.signingSecret)
      .update(`${storageKey}:${expiresAt}`)
      .digest("hex");
  }

  private normalizeStorageKey(storageKey: string): string {
    if (typeof storageKey !== "string" || !storageKey.trim() || storageKey.includes("\0")) {
      throw new Error("Invalid media storage key");
    }

    const normalized = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Invalid media storage key");
    }

    return segments.join("/");
  }

  private resolveStoragePath(storageKey: string): string {
    const fullPath = path.resolve(this.localVaultPath, ...storageKey.split("/"));
    const relativePath = path.relative(this.localVaultPath, fullPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Media storage key escapes the local vault");
    }
    return fullPath;
  }

  private getExtensionFromMime(mimeType: string): string {
    switch (mimeType) {
      case "image/jpeg": return ".jpg";
      case "image/png": return ".png";
      case "image/webp": return ".webp";
      case "application/pdf": return ".pdf";
      case "audio/mpeg": return ".mp3";
      case "audio/wav": return ".wav";
      default: return ".bin";
    }
  }

  private getMimeFromExtension(ext: string): string {
    switch (ext) {
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".png": return "image/png";
      case ".webp": return "image/webp";
      case ".pdf": return "application/pdf";
      case ".mp3": return "audio/mpeg";
      case ".wav": return "audio/wav";
      default: return "application/octet-stream";
    }
  }
}
