import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env.schema';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

@Injectable()
export class TotpService {
  private readonly encryptionKey: Buffer;

  constructor(@Inject(ConfigService) config: ConfigService<AppEnv, true>) {
    const rawSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.encryptionKey = createHash('sha256').update(rawSecret).digest();
  }

  /**
   * Generates a 160-bit Base32 TOTP secret and otpauth:// URI for authenticator apps.
   */
  generateSecret(email: string): { base32Secret: string; otpauthUrl: string } {
    const raw = randomBytes(20);
    const base32Secret = this.encodeBase32(raw);
    const issuer = encodeURIComponent('Teamloom');
    const account = encodeURIComponent(email);
    const otpauthUrl = `otpauth://totp/${issuer}:${account}?secret=${base32Secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    return { base32Secret, otpauthUrl };
  }

  /**
   * Generates a 6-digit RFC 6238 TOTP code for a given timestamp.
   */
  generateCode(base32Secret: string, timestampMs = Date.now()): string {
    const key = this.decodeBase32(base32Secret);
    const counter = Math.floor(timestampMs / 1000 / 30);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigInt64BE(BigInt(counter), 0);

    const hmac = createHmac('sha1', key).update(counterBuf).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const binary =
      (((hmac[offset] ?? 0) & 0x7f) << 24) |
      (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[offset + 3] ?? 0) & 0xff);

    const otp = binary % 1_000_000;
    return otp.toString().padStart(6, '0');
  }

  /**
   * Verifies a 6-digit TOTP code allowing +/- 1 time step (30s drift window).
   */
  verifyCode(base32Secret: string, code: string, timestampMs = Date.now()): boolean {
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return false;
    }

    for (const stepOffset of [-1, 0, 1]) {
      const candidate = this.generateCode(
        base32Secret,
        timestampMs + stepOffset * 30_000,
      );
      if (candidate === cleanCode) {
        return true;
      }
    }
    return false;
  }

  /**
   * Encrypts the TOTP secret with AES-256-GCM before storing in Postgres.
   */
  encryptSecret(base32Secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(base32Secret, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decryptSecret(encryptedPayload: string): string {
    const [ivHex, authTagHex, cipherHex] = encryptedPayload.split(':');
    if (!ivHex || !authTagHex || !cipherHex) {
      throw new Error('Malformed encrypted TOTP secret');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Generates 8 single-use recovery codes (e.g. "A1B2-C3D4") and their SHA-256 hashes.
   */
  generateRecoveryCodes(): { plainCodes: string[]; codeHashes: string[] } {
    const plainCodes: string[] = [];
    const codeHashes: string[] = [];

    for (let i = 0; i < 8; i++) {
      const raw = randomBytes(4).toString('hex').toUpperCase();
      const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
      plainCodes.push(formatted);
      codeHashes.push(this.hashRecoveryCode(formatted));
    }

    return { plainCodes, codeHashes };
  }

  hashRecoveryCode(code: string): string {
    return createHash('sha256')
      .update(code.trim().toUpperCase())
      .digest('hex');
  }

  private encodeBase32(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buf) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
  }

  private decodeBase32(str: string): Buffer {
    const clean = str.toUpperCase().replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (const char of clean) {
      const idx = BASE32_ALPHABET.indexOf(char);
      if (idx === -1) {
        continue;
      }
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }
}