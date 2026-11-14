import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AcceptOrganizationInviteRequest,
  CreateOrganizationRequest,
  InviteOrganizationMemberRequest,
  OrganizationRole,
  OrganizationSummary,
  TransferOwnershipRequest,
  UpdateMemberRoleRequest,
  UpdateOrganizationAiSettingsRequest,
} from '@teamloom/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AuditLogService } from '../audit/audit-log.service';
import type { RequestMetadata } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import { DatabaseService } from '../database/database.module';
import {
  organizationInvites,
  organizationMembers,
  organizations,
  users,
} from '../database/schema';
import { EmailService } from '../email/email.service';

export interface OrganizationMemberDetails {
  userId: string;
  email: string;
  fullName: string;
  role: OrganizationRole;
  guestProjectIds: string[];
  joinedAt: string;
}

export interface OrganizationInviteDetails {
  id: string;
  email: string;
  role: Exclude<OrganizationRole, 'owner'>;
  guestProjectIds: string[];
  expiresAt: string;
  createdAt: string;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
    @Inject(TokenService) private readonly tokenService: TokenService,
    @Inject(EmailService) private readonly emailService: EmailService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
  ) {}

  async createOrganization(
    userId: string,
    input: CreateOrganizationRequest,
    meta: RequestMetadata,
  ): Promise<OrganizationSummary> {
    const slug = input.slug.toLowerCase();
    const existingSlug = await this.dbService.db.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    });

    if (existingSlug) {
      throw new ConflictException({
        errorCode: 'ORGANIZATION_SLUG_TAKEN',
        message: `Organization slug '${slug}' is already in use`,
      });
    }

    const [createdOrg] = await this.dbService.db
      .insert(organizations)
      .values({
        name: input.name,
        slug,
        ownerId: userId,
      })
      .returning();

    if (!createdOrg) {
      throw new Error('Failed to insert organization');
    }

    await this.dbService.withTenantContext(
      { organizationId: createdOrg.id, userId },
      async (tx) => {
        await tx.insert(organizationMembers).values({
          organizationId: createdOrg.id,
          userId,
          role: 'owner',
          guestProjectIds: [],
        });

        await this.auditLog.record(
          {
            organizationId: createdOrg.id,
            actorUserId: userId,
            actorType: 'user',
            action: 'org.created',
            targetType: 'organization',
            targetId: createdOrg.id,
            metadata: { name: createdOrg.name, slug: createdOrg.slug },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return {
      id: createdOrg.id,
      name: createdOrg.name,
      slug: createdOrg.slug,
      ownerId: createdOrg.ownerId,
      myRole: 'owner',
      aiEnabled: createdOrg.aiEnabled,
      aiKillSwitch: createdOrg.aiKillSwitch,
      monthlyAiBudgetUsdCents: createdOrg.monthlyAiBudgetUsdCents,
      createdAt: createdOrg.createdAt.toISOString(),
    };
  }

  async listUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
    const memberships = await this.dbService.withTenantContext(
      { organizationId: '00000000-0000-0000-0000-000000000000', userId },
      async (tx) => {
        return tx.query.organizationMembers.findMany({
          where: eq(organizationMembers.userId, userId),
        });
      },
    );

    if (memberships.length === 0) {
      return [];
    }

    const orgIds = memberships.map((m) => m.organizationId);
    const orgRows = await this.dbService.db.query.organizations.findMany({
      where: inArray(organizations.id, orgIds),
    });

    const roleByOrgId = new Map<string, OrganizationRole>(
      memberships.map((m) => [m.organizationId, m.role]),
    );

    return orgRows.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId,
      myRole: roleByOrgId.get(org.id) ?? 'guest',
      aiEnabled: org.aiEnabled,
      aiKillSwitch: org.aiKillSwitch,
      monthlyAiBudgetUsdCents: org.monthlyAiBudgetUsdCents,
      createdAt: org.createdAt.toISOString(),
    }));
  }

  async getOrganizationSummary(
    organizationId: string,
    userId: string,
    myRole: OrganizationRole,
  ): Promise<OrganizationSummary> {
    const org = await this.dbService.db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });

    if (!org) {
      throw new NotFoundException({
        errorCode: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId,
      myRole,
      aiEnabled: org.aiEnabled,
      aiKillSwitch: org.aiKillSwitch,
      monthlyAiBudgetUsdCents: org.monthlyAiBudgetUsdCents,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async updateAiSettings(
    organizationId: string,
    actorUserId: string,
    myRole: OrganizationRole,
    input: UpdateOrganizationAiSettingsRequest,
    meta: RequestMetadata,
  ): Promise<OrganizationSummary> {
    const [updatedOrg] = await this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const rows = await tx
          .update(organizations)
          .set({
            ...(input.aiEnabled !== undefined
              ? { aiEnabled: input.aiEnabled }
              : {}),
            ...(input.aiKillSwitch !== undefined
              ? { aiKillSwitch: input.aiKillSwitch }
              : {}),
            ...(input.monthlyAiBudgetUsdCents !== undefined
              ? { monthlyAiBudgetUsdCents: input.monthlyAiBudgetUsdCents }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, organizationId))
          .returning();

        await this.auditLog.record(
          {
            organizationId,
            actorUserId,
            actorType: 'user',
            action: 'org.ai_settings_updated',
            targetType: 'organization',
            targetId: organizationId,
            metadata: { ...input },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return rows;
      },
    );

    if (!updatedOrg) {
      throw new NotFoundException({
        errorCode: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return {
      id: updatedOrg.id,
      name: updatedOrg.name,
      slug: updatedOrg.slug,
      ownerId: updatedOrg.ownerId,
      myRole,
      aiEnabled: updatedOrg.aiEnabled,
      aiKillSwitch: updatedOrg.aiKillSwitch,
      monthlyAiBudgetUsdCents: updatedOrg.monthlyAiBudgetUsdCents,
      createdAt: updatedOrg.createdAt.toISOString(),
    };
  }

  async listMembers(
    organizationId: string,
    actorUserId: string,
  ): Promise<OrganizationMemberDetails[]> {
    return this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const rows = await tx
          .select({
            userId: organizationMembers.userId,
            email: users.email,
            fullName: users.fullName,
            role: organizationMembers.role,
            guestProjectIds: organizationMembers.guestProjectIds,
            joinedAt: organizationMembers.joinedAt,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(eq(organizationMembers.organizationId, organizationId));

        return rows.map((r) => ({
          userId: r.userId,
          email: r.email,
          fullName: r.fullName,
          role: r.role,
          guestProjectIds: r.guestProjectIds ?? [],
          joinedAt: r.joinedAt.toISOString(),
        }));
      },
    );
  }

  async inviteMember(
    organizationId: string,
    actorUserId: string,
    input: InviteOrganizationMemberRequest,
    meta: RequestMetadata,
  ): Promise<OrganizationInviteDetails> {
    const email = input.email.toLowerCase();
    const [org, inviter] = await Promise.all([
      this.dbService.db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      }),
      this.dbService.db.query.users.findFirst({
        where: eq(users.id, actorUserId),
      }),
    ]);

    if (!org || !inviter) {
      throw new NotFoundException({
        errorCode: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const existingUser = await this.dbService.db.query.users.findFirst({
      where: eq(users.email, email),
    });

    const { rawToken, tokenHash } = this.tokenService.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const createdInvite = await this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        if (existingUser) {
          const alreadyMember =
            await tx.query.organizationMembers.findFirst({
              where: and(
                eq(organizationMembers.organizationId, organizationId),
                eq(organizationMembers.userId, existingUser.id),
              ),
            });

          if (alreadyMember) {
            throw new ConflictException({
              errorCode: 'ALREADY_ORGANIZATION_MEMBER',
              message: 'This user is already a member of the organization',
            });
          }
        }

        const [invite] = await tx
          .insert(organizationInvites)
          .values({
            organizationId,
            email,
            role: input.role,
            guestProjectIds:
              input.role === 'guest' ? (input.guestProjectIds ?? []) : [],
            tokenHash,
            invitedByUserId: actorUserId,
            expiresAt,
          })
          .returning();

        if (!invite) {
          throw new Error('Failed to create organization invite');
        }

        await this.auditLog.record(
          {
            organizationId,
            actorUserId,
            actorType: 'user',
            action: 'member.invited',
            targetType: 'organization_invite',
            targetId: invite.id,
            metadata: { email, role: input.role },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return invite;
      },
    );

    await this.emailService.sendOrganizationInviteEmail({
      to: email,
      organizationName: org.name,
      inviterName: inviter.fullName,
      role: input.role,
      rawToken,
    });

    return {
      id: createdInvite.id,
      email: createdInvite.email,
      role: createdInvite.role,
      guestProjectIds: createdInvite.guestProjectIds ?? [],
      expiresAt: createdInvite.expiresAt.toISOString(),
      createdAt: createdInvite.createdAt.toISOString(),
    };
  }

  async acceptInvite(
    userId: string,
    userEmail: string,
    input: AcceptOrganizationInviteRequest,
    meta: RequestMetadata,
  ): Promise<OrganizationSummary> {
    const tokenHash = this.tokenService.hashToken(input.token);

    const lookupRes = await this.dbService.pool.query<{
      organization_id: string | null;
    }>('SELECT lookup_invite_organization_by_hash($1) AS organization_id', [
      tokenHash,
    ]);

    const organizationId = lookupRes.rows[0]?.organization_id;
    if (!organizationId) {
      throw new BadRequestException({
        errorCode: 'INVALID_OR_EXPIRED_INVITE',
        message: 'Organization invitation is invalid or has expired',
      });
    }

    const assignedRole = await this.dbService.withTenantContext(
      { organizationId, userId },
      async (tx) => {
        const invite = await tx.query.organizationInvites.findFirst({
          where: eq(organizationInvites.tokenHash, tokenHash),
        });

        if (
          !invite ||
          invite.acceptedAt !== null ||
          invite.revokedAt !== null ||
          invite.expiresAt.getTime() < Date.now()
        ) {
          throw new BadRequestException({
            errorCode: 'INVALID_OR_EXPIRED_INVITE',
            message: 'Organization invitation is invalid or has expired',
          });
        }

        if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
          throw new ForbiddenException({
            errorCode: 'INVITE_EMAIL_MISMATCH',
            message:
              'This invitation was issued to a different email address',
          });
        }

        const existingMember =
          await tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, userId),
            ),
          });

        if (existingMember) {
          throw new ConflictException({
            errorCode: 'ALREADY_ORGANIZATION_MEMBER',
            message: 'You are already a member of this organization',
          });
        }

        await tx
          .update(organizationInvites)
          .set({ acceptedAt: new Date() })
          .where(eq(organizationInvites.id, invite.id));

        await tx.insert(organizationMembers).values({
          organizationId,
          userId,
          role: invite.role,
          guestProjectIds: invite.guestProjectIds ?? [],
        });

        await this.auditLog.record(
          {
            organizationId,
            actorUserId: userId,
            actorType: 'user',
            action: 'member.invite_accepted',
            targetType: 'organization_invite',
            targetId: invite.id,
            metadata: { role: invite.role, email: userEmail },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return invite.role;
      },
    );

    return this.getOrganizationSummary(organizationId, userId, assignedRole);
  }

  async revokeInvite(
    organizationId: string,
    actorUserId: string,
    inviteId: string,
    meta: RequestMetadata,
  ): Promise<{ revoked: true }> {
    await this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const invite = await tx.query.organizationInvites.findFirst({
          where: and(
            eq(organizationInvites.id, inviteId),
            eq(organizationInvites.organizationId, organizationId),
            isNull(organizationInvites.acceptedAt),
            isNull(organizationInvites.revokedAt),
          ),
        });

        if (!invite) {
          throw new NotFoundException({
            errorCode: 'INVITE_NOT_FOUND',
            message: 'Pending organization invite not found',
          });
        }

        await tx
          .update(organizationInvites)
          .set({ revokedAt: new Date() })
          .where(eq(organizationInvites.id, inviteId));

        await this.auditLog.record(
          {
            organizationId,
            actorUserId,
            actorType: 'user',
            action: 'member.invite_revoked',
            targetType: 'organization_invite',
            targetId: inviteId,
            metadata: { email: invite.email },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { revoked: true };
  }

  async updateMemberRole(
    organizationId: string,
    actorUserId: string,
    targetUserId: string,
    input: UpdateMemberRoleRequest,
    meta: RequestMetadata,
  ): Promise<{ updated: true; role: OrganizationRole }> {
    await this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const targetMember = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, targetUserId),
          ),
        });

        if (!targetMember) {
          throw new NotFoundException({
            errorCode: 'MEMBER_NOT_FOUND',
            message: 'Member not found in this organization',
          });
        }

        if (targetMember.role === 'owner') {
          throw new BadRequestException({
            errorCode: 'CANNOT_DEMOTE_OWNER',
            message:
              'Organization owner role can only be changed via ownership transfer',
          });
        }

        await tx
          .update(organizationMembers)
          .set({
            role: input.role,
            guestProjectIds:
              input.role === 'guest'
                ? (input.guestProjectIds ?? targetMember.guestProjectIds ?? [])
                : [],
          })
          .where(eq(organizationMembers.id, targetMember.id));

        await this.auditLog.record(
          {
            organizationId,
            actorUserId,
            actorType: 'user',
            action: 'member.role_updated',
            targetType: 'user',
            targetId: targetUserId,
            metadata: {
              previousRole: targetMember.role,
              newRole: input.role,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { updated: true, role: input.role };
  }

  async removeMember(
    organizationId: string,
    actorUserId: string,
    targetUserId: string,
    meta: RequestMetadata,
  ): Promise<{ removed: true }> {
    await this.dbService.withTenantContext(
      { organizationId, userId: actorUserId },
      async (tx) => {
        const targetMember = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, targetUserId),
          ),
        });

        if (!targetMember) {
          throw new NotFoundException({
            errorCode: 'MEMBER_NOT_FOUND',
            message: 'Member not found in this organization',
          });
        }

        if (targetMember.role === 'owner') {
          throw new BadRequestException({
            errorCode: 'CANNOT_REMOVE_OWNER',
            message: 'Cannot remove the organization owner',
          });
        }

        await tx
          .delete(organizationMembers)
          .where(eq(organizationMembers.id, targetMember.id));

        await this.auditLog.record(
          {
            organizationId,
            actorUserId,
            actorType: 'user',
            action: 'member.removed',
            targetType: 'user',
            targetId: targetUserId,
            metadata: { removedRole: targetMember.role },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { removed: true };
  }

  async transferOwnership(
    organizationId: string,
    currentOwnerId: string,
    input: TransferOwnershipRequest,
    meta: RequestMetadata,
  ): Promise<{ transferred: true; newOwnerUserId: string }> {
    if (currentOwnerId === input.newOwnerUserId) {
      throw new BadRequestException({
        errorCode: 'ALREADY_OWNER',
        message: 'You are already the owner of this organization',
      });
    }

    await this.dbService.withTenantContext(
      { organizationId, userId: currentOwnerId },
      async (tx) => {
        const [currentOwnerMember, newOwnerMember] = await Promise.all([
          tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, currentOwnerId),
            ),
          }),
          tx.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.userId, input.newOwnerUserId),
            ),
          }),
        ]);

        if (!currentOwnerMember || currentOwnerMember.role !== 'owner') {
          throw new ForbiddenException({
            errorCode: 'ONLY_OWNER_CAN_TRANSFER',
            message:
              'Only the current organization owner can transfer ownership',
          });
        }

        if (!newOwnerMember) {
          throw new BadRequestException({
            errorCode: 'NEW_OWNER_NOT_MEMBER',
            message:
              'The target user must already be a member of the organization',
          });
        }

        if (newOwnerMember.role === 'guest') {
          throw new BadRequestException({
            errorCode: 'CANNOT_TRANSFER_TO_GUEST',
            message: 'Cannot transfer organization ownership to a guest account',
          });
        }

        await tx
          .update(organizationMembers)
          .set({ role: 'admin' })
          .where(eq(organizationMembers.id, currentOwnerMember.id));

        await tx
          .update(organizationMembers)
          .set({ role: 'owner', guestProjectIds: [] })
          .where(eq(organizationMembers.id, newOwnerMember.id));

        await tx
          .update(organizations)
          .set({ ownerId: input.newOwnerUserId, updatedAt: new Date() })
          .where(eq(organizations.id, organizationId));

        await this.auditLog.record(
          {
            organizationId,
            actorUserId: currentOwnerId,
            actorType: 'user',
            action: 'org.ownership_transferred',
            targetType: 'organization',
            targetId: organizationId,
            metadata: {
              previousOwnerUserId: currentOwnerId,
              newOwnerUserId: input.newOwnerUserId,
            },
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          tx,
        );
      },
    );

    return { transferred: true, newOwnerUserId: input.newOwnerUserId };
  }
}