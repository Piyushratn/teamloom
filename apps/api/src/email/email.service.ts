import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { AppEnv } from '../config/env.schema';

export interface SentEmailRecord {
  to: string;
  subject: string;
  html: string;
  text: string;
  token?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;
  private readonly webAppUrl: string;
  private readonly nodeEnv: string;

  /**
   * In-memory outbox populated in 'test' mode so integration tests can inspect
   * verification, reset, and invite tokens deterministically.
   */
  public readonly testOutbox: SentEmailRecord[] = [];

  constructor(@Inject(ConfigService) config: ConfigService<AppEnv, true>) {
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
    this.fromAddress = config.get('EMAIL_FROM', { infer: true });
    this.webAppUrl = config.get('WEB_APP_URL', { infer: true });

    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: false,
    });
  }

  async sendVerificationEmail(
    to: string,
    fullName: string,
    rawToken: string,
  ): Promise<void> {
    const verifyUrl = `${this.webAppUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;
    const subject = 'Verify your Teamloom email address';
    const text = `Hi ${fullName},\n\nPlease verify your Teamloom account by opening this link (valid for 24 hours):\n${verifyUrl}\n`;
    const html = `<p>Hi <strong>${this.escapeHtml(fullName)}</strong>,</p><p>Please verify your Teamloom account by clicking the link below (valid for 24 hours):</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;

    await this.deliver({ to, subject, text, html, token: rawToken });
  }

  async sendPasswordResetEmail(
    to: string,
    fullName: string,
    rawToken: string,
  ): Promise<void> {
    const resetUrl = `${this.webAppUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
    const subject = 'Reset your Teamloom password';
    const text = `Hi ${fullName},\n\nA password reset was requested for your Teamloom account. Open this link within 1 hour to set a new password:\n${resetUrl}\n`;
    const html = `<p>Hi <strong>${this.escapeHtml(fullName)}</strong>,</p><p>A password reset was requested for your Teamloom account. Click the link below within 1 hour to set a new password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;

    await this.deliver({ to, subject, text, html, token: rawToken });
  }

  async sendOrganizationInviteEmail(params: {
    to: string;
    organizationName: string;
    inviterName: string;
    role: string;
    rawToken: string;
  }): Promise<void> {
    const inviteUrl = `${this.webAppUrl}/accept-invite?token=${encodeURIComponent(params.rawToken)}`;
    const subject = `You've been invited to join ${params.organizationName} on Teamloom`;
    const text = `Hi,\n\n${params.inviterName} invited you to join "${params.organizationName}" as a ${params.role} on Teamloom.\nAccept your invitation within 7 days:\n${inviteUrl}\n`;
    const html = `<p>Hi,</p><p><strong>${this.escapeHtml(params.inviterName)}</strong> invited you to join <strong>${this.escapeHtml(params.organizationName)}</strong> as a <code>${this.escapeHtml(params.role)}</code> on Teamloom.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`;

    await this.deliver({
      to: params.to,
      subject,
      text,
      html,
      token: params.rawToken,
    });
  }

  private async deliver(record: SentEmailRecord): Promise<void> {
    if (this.nodeEnv === 'test') {
      this.testOutbox.push(record);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to: record.to,
        subject: record.subject,
        text: record.text,
        html: record.html,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to send email "${record.subject}" to ${record.to}: ${err instanceof Error ? err.message : 'Unknown SMTP error'}`,
      );
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}