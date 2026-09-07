import { UploadMediaOptions, UploadMediaResult } from "../types/mediaStorage.types";

export interface IMediaStorageService {
  upload(options: UploadMediaOptions): Promise<UploadMediaResult>;
  download(storageKey: string): Promise<{ buffer: Buffer; mimeType: string }>;
  generatePresignedUrl(storageKey: string, expiresInSeconds?: number): Promise<string>;
  generateDirectUploadUrl?(storageKey: string, expiresInSeconds?: number): Promise<string>;
  saveBuffer?(storageKey: string, buffer: Buffer): Promise<void>;
  verifyPresignedUrl(storageKey: string, expires: string | number, signature: string): boolean;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
}
