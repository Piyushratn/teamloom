import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiBudgetSummary,
  AiFeatureType,
  KnowledgeSearchResultItem,
  ProposedActionType,
} from '@teamloom/contracts';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { AppEnv } from '../config/env.schema';
import {
  DatabaseService,
  type DrizzleDb,
} from '../database/database.module';
import { aiUsageLedger, organizations } from '../database/schema';
import type { TenantMembershipContext } from '../organizations/require-permission.decorator';

export interface LlmCompletionResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdCents: number;
}

export interface GeneratedActionDraft {
  actionType: ProposedActionType;
  title: string;
  rationale: string;
  payload: Record<string, unknown>;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly nodeEnv: string;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppEnv, true>,
    @Inject(DatabaseService) private readonly dbService: DatabaseService,
  ) {
    this.apiKey = config.get('GEMINI_API_KEY', { infer: true });
    this.model = config.get('LLM_CHAT_MODEL', { infer: true });
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
  }

  /**
   * Returns the current calendar month's AI usage and budget status for an organization.
   */
  async getBudgetSummary(
    tenant: TenantMembershipContext,
  ): Promise<AiBudgetSummary> {
    return this.dbService.withTenantContext(
      { organizationId: tenant.organizationId, userId: tenant.userId },
      async (tx) => {
        return this.computeBudgetSummaryInTx(tx, tenant.organizationId);
      },
    );
  }

  /**
   * Enforces organization AI governance (`aiEnabled`, `aiKillSwitch`, `monthlyAiBudgetUsdCents`),
   * generates grounded answer Markdown from retrieved RAG context, and records token spend in `ai_usage_ledger`.
   */
  async generateCopilotAnswer(params: {
    tenant: TenantMembershipContext;
    question: string;
    contextChunks: KnowledgeSearchResultItem[];
  }): Promise<LlmCompletionResult> {
    return this.dbService.withTenantContext(
      {
        organizationId: params.tenant.organizationId,
        userId: params.tenant.userId,
      },
      async (tx) => {
        await this.assertCanExecuteAiInTx(tx, params.tenant.organizationId);

        const contextBlock =
          params.contextChunks.length > 0
            ? params.contextChunks
                .map(
                  (c, idx) =>
                    `[Source ${idx + 1} | ${c.sourceType.toUpperCase()} | ${c.title}]\n${c.content}`,
                )
                .join('\n\n')
            : 'No matching workspace documents or tasks were found.';

        const systemPrompt = [
          'You are Teamloom Copilot, an enterprise Work OS assistant.',
          'Answer the user question concisely using ONLY the provided workspace sources.',
          'Cite sources inline like [Source 1] when referencing facts.',
        ].join(' ');

        const userPrompt = `Workspace Context:\n${contextBlock}\n\nQuestion: ${params.question}`;

        const completion = await this.invokeModelOrFallback(
          systemPrompt,
          userPrompt,
          () =>
            this.buildDeterministicCopilotAnswer(
              params.question,
              params.contextChunks,
            ),
        );

        await this.recordUsageInTx(tx, {
          organizationId: params.tenant.organizationId,
          actorUserId: params.tenant.userId,
          feature: 'copilot_ask',
          completion,
        });

        return completion;
      },
    );
  }

  /**
   * Enforces organization AI governance, analyzes the project's current tasks/docs + goal,
   * returns structured action proposals (`create_task`, `update_task`, `create_document`),
   * and records token spend in `ai_usage_ledger`.
   */
  async generateProjectActionProposals(params: {
    tenant: TenantMembershipContext;
    projectKey: string;
    projectName: string;
    goal: string;
    mode: 'project_triage' | 'sprint_plan';
    existingTasksSummary: Array<{
      id: string;
      displayId: string;
      title: string;
      status: string;
      priority: string;
    }>;
  }): Promise<{
    proposals: GeneratedActionDraft[];
    usage: LlmCompletionResult;
  }> {
    return this.dbService.withTenantContext(
      {
        organizationId: params.tenant.organizationId,
        userId: params.tenant.userId,
      },
      async (tx) => {
        await this.assertCanExecuteAiInTx(tx, params.tenant.organizationId);

        const tasksContext =
          params.existingTasksSummary.length > 0
            ? params.existingTasksSummary
                .map(
                  (t) =>
                    `- ${t.displayId} (id=${t.id}, status=${t.status}, priority=${t.priority}): ${t.title}`,
                )
                .join('\n')
            : 'No existing tasks in project.';

        const prompt = `Project: ${params.projectKey} (${params.projectName})\nMode: ${params.mode}\nGoal: ${params.goal}\nExisting Tasks:\n${tasksContext}`;

        const deterministicProposals = this.buildDeterministicProposals(params);

        const completion = await this.invokeModelOrFallback(
          'You are Teamloom Autonomous Planner. Propose concrete project actions.',
          prompt,
          () => JSON.stringify(deterministicProposals),
        );

        await this.recordUsageInTx(tx, {
          organizationId: params.tenant.organizationId,
          actorUserId: params.tenant.userId,
          feature: params.mode,
          completion,
        });

        return {
          proposals: deterministicProposals,
          usage: completion,
        };
      },
    );
  }

  private async assertCanExecuteAiInTx(
    tx: DrizzleDb,
    organizationId: string,
  ): Promise<AiBudgetSummary> {
    const summary = await this.computeBudgetSummaryInTx(tx, organizationId);

    if (summary.aiKillSwitch) {
      throw new ForbiddenException({
        errorCode: 'AI_KILL_SWITCH_ACTIVE',
        message:
          'Organization AI kill switch is currently active; all AI operations are halted',
      });
    }

    if (!summary.aiEnabled) {
      throw new ForbiddenException({
        errorCode: 'AI_DISABLED_FOR_ORGANIZATION',
        message: 'AI features are disabled for this organization',
      });
    }

    if (summary.remainingBudgetUsdCents <= 0) {
      throw new HttpException(
        {
          errorCode: 'AI_MONTHLY_BUDGET_EXCEEDED',
          message: `Monthly AI budget of ${summary.monthlyAiBudgetUsdCents} USD cents has been reached`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return summary;
  }

  private async computeBudgetSummaryInTx(
    tx: DrizzleDb,
    organizationId: string,
  ): Promise<AiBudgetSummary> {
    const org = await tx.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });

    if (!org) {
      throw new NotFoundException({
        errorCode: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
    );

    const [agg] = await tx
      .select({
        totalSpend: sql<number>`coalesce(sum(${aiUsageLedger.costUsdCents}), 0)::int`,
        totalRequests: sql<number>`count(*)::int`,
      })
      .from(aiUsageLedger)
      .where(
        and(
          eq(aiUsageLedger.organizationId, organizationId),
          gte(aiUsageLedger.createdAt, startOfMonth),
        ),
      );

    const currentMonthSpendUsdCents = Number(agg?.totalSpend ?? 0);
    const totalRequestsThisMonth = Number(agg?.totalRequests ?? 0);
    const remainingBudgetUsdCents = Math.max(
      0,
      org.monthlyAiBudgetUsdCents - currentMonthSpendUsdCents,
    );

    return {
      aiEnabled: org.aiEnabled,
      aiKillSwitch: org.aiKillSwitch,
      monthlyAiBudgetUsdCents: org.monthlyAiBudgetUsdCents,
      currentMonthSpendUsdCents,
      remainingBudgetUsdCents,
      totalRequestsThisMonth,
    };
  }

  private async recordUsageInTx(
    tx: DrizzleDb,
    params: {
      organizationId: string;
      actorUserId: string;
      feature: AiFeatureType;
      completion: LlmCompletionResult;
    },
  ): Promise<void> {
    await tx.insert(aiUsageLedger).values({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      feature: params.feature,
      model: params.completion.model,
      promptTokens: params.completion.promptTokens,
      completionTokens: params.completion.completionTokens,
      totalTokens: params.completion.totalTokens,
      costUsdCents: params.completion.costUsdCents,
    });
  }

  private async invokeModelOrFallback(
    systemInstruction: string,
    userPrompt: string,
    fallbackFn: () => string,
  ): Promise<LlmCompletionResult> {
    const useLiveGemini =
      this.nodeEnv !== 'test' &&
      Boolean(this.apiKey) &&
      this.apiKey !== 'your_gemini_api_key_here';

    if (useLiveGemini) {
      try {
        return await this.callGeminiGenerateContent(
          systemInstruction,
          userPrompt,
        );
      } catch (err) {
        this.logger.warn(
          `Gemini generateContent failed (${err instanceof Error ? err.message : 'unknown error'}); using deterministic synthesis`,
        );
      }
    }

    const text = fallbackFn();
    const promptTokens = Math.max(
      10,
      Math.ceil((systemInstruction.length + userPrompt.length) / 4),
    );
    const completionTokens = Math.max(10, Math.ceil(text.length / 4));
    const totalTokens = promptTokens + completionTokens;

    return {
      text,
      model: `${this.model}-deterministic`,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsdCents: 1,
    };
  }

  private async callGeminiGenerateContent(
    systemInstruction: string,
    userPrompt: string,
  ): Promise<LlmCompletionResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini generateContent HTTP ${response.status}`);
    }

    const data = (await response.json()) as GeminiGenerateContentResponse;
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .trim() ?? '';

    if (!text) {
      throw new Error('Empty response from Gemini generateContent');
    }

    const promptTokens = data.usageMetadata?.promptTokenCount ?? 120;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 80;
    const totalTokens =
      data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;

    return {
      text,
      model: this.model,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsdCents: Math.max(1, Math.ceil(totalTokens / 2500)),
    };
  }

  private buildDeterministicCopilotAnswer(
    question: string,
    chunks: KnowledgeSearchResultItem[],
  ): string {
    if (chunks.length === 0) {
      return `I searched the accessible workspace knowledge base for **"${question}"**, but no matching documents or tasks were found.`;
    }

    const top = chunks[0]!;
    const summaryLines = chunks.slice(0, 3).map((c, idx) => {
      const snippet =
        c.content.length > 220 ? `${c.content.slice(0, 220)}...` : c.content;
      return `- **[Source ${idx + 1}: ${c.title}]** (${c.sourceType}): ${snippet}`;
    });

    return [
      `Based on your workspace knowledge base, the primary reference is **${top.title}** [Source 1]:`,
      '',
      ...summaryLines,
    ].join('\n');
  }

  private buildDeterministicProposals(params: {
    projectKey: string;
    projectName: string;
    goal: string;
    mode: 'project_triage' | 'sprint_plan';
    existingTasksSummary: Array<{
      id: string;
      displayId: string;
      title: string;
      status: string;
      priority: string;
    }>;
  }): GeneratedActionDraft[] {
    const proposals: GeneratedActionDraft[] = [];

    // 1. Propose a concrete implementation task aligned with the user's goal
    proposals.push({
      actionType: 'create_task',
      title: `Execute: ${params.goal.slice(0, 120)}`,
      rationale: `Generated by ${params.mode} agent to break down goal "${params.goal}" inside project ${params.projectKey}.`,
      payload: {
        title: `Implement: ${params.goal.slice(0, 120)}`,
        description: `Automated ${params.mode} task proposal for goal:\n\n${params.goal}`,
        priority: 'high',
        status: 'todo',
        labels: ['ai-proposed', params.mode],
      },
    });

    // 2. If there is an existing backlog/todo task, propose triaging its priority/status;
    //    otherwise propose creating a sprint runbook document.
    const candidateTask = params.existingTasksSummary.find(
      (t) => t.status === 'backlog' || t.status === 'todo',
    );

    if (candidateTask && params.mode === 'project_triage') {
      proposals.push({
        actionType: 'update_task',
        title: `Elevate ${candidateTask.displayId} priority to high`,
        rationale: `Task ${candidateTask.displayId} ("${candidateTask.title}") aligns with the active triage goal and is currently in ${candidateTask.status}.`,
        payload: {
          taskId: candidateTask.id,
          priority: 'high',
          status: 'in_progress',
        },
      });
    } else {
      proposals.push({
        actionType: 'create_document',
        title: `${params.projectKey} Architecture & Execution Plan: ${params.goal.slice(0, 60)}`,
        rationale: `Documents the technical specification and acceptance criteria for "${params.goal}".`,
        payload: {
          title: `${params.projectKey} Execution Plan — ${params.goal.slice(0, 60)}`,
          contentMarkdown: `# ${params.projectName} (${params.projectKey}) Execution Plan\n\n## Objective\n${params.goal}\n\n## Verification Checklist\n- [ ] Implementation complete\n- [ ] Automated tests passing`,
        },
      });
    }

    return proposals;
  }
}