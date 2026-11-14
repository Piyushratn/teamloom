import { Global, Module } from '@nestjs/common';
import { AiAgentController } from './ai-agent.controller';
import { AiAgentService } from './ai-agent.service';
import { LlmGatewayService } from './llm-gateway.service';

@Global()
@Module({
  controllers: [AiAgentController],
  providers: [LlmGatewayService, AiAgentService],
  exports: [LlmGatewayService, AiAgentService],
})
export class AiModule {}