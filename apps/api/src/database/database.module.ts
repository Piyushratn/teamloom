import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import type { AppEnv } from '../config/env.schema';
import * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export type DrizzleDb = NodePgDatabase<typeof schema>;

export interface TenantRlsContext {
  organizationId: string;
  userId?: string;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  public readonly db: DrizzleDb;

  constructor(@Inject(PG_POOL) public readonly pool: Pool) {
    this.db = drizzle(this.pool, { schema });
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Executes a callback inside a PostgreSQL transaction with session-local
   * Row-Level Security variables (`app.current_organization_id` and `app.current_user_id`) set.
   * Because `set_config(..., true)` is transaction-scoped, settings never leak across pooled connections.
   */
  async withTenantContext<T>(
    ctx: TenantRlsContext,
    fn: (tx: DrizzleDb, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true), set_config('app.current_user_id', $2, true)`,
        [ctx.organizationId, ctx.userId ?? ''],
      );

      const txDb = drizzle(client, { schema });
      const result = await fn(txDb, client);

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => {
        return new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
      },
    },
    DatabaseService,
  ],
  exports: [PG_POOL, DatabaseService],
})
export class DatabaseModule {}