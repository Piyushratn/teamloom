import { Injectable, type OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP minimum recommendation for argon2id)
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash('dummy_password_for_constant_time_check');
  }

  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, plainPassword: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, plainPassword);
    } catch {
      return false;
    }
  }

  /**
   * Prevents timing enumeration when a login attempt references an email that does not exist.
   */
  async verifyDummy(plainPassword: string): Promise<void> {
    if (!this.dummyHash) {
      this.dummyHash = await this.hash('dummy_password_for_constant_time_check');
    }
    await this.verify(this.dummyHash, plainPassword);
  }
}