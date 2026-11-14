import { Global, Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Global()
@Module({
  controllers: [ProjectsController, TasksController, DocumentsController],
  providers: [ProjectsService, TasksService, DocumentsService],
  exports: [ProjectsService, TasksService, DocumentsService],
})
export class WorkOsModule {}