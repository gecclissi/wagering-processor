import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Clock, IdGenerator, UnitOfWork, WalletReadRepository } from './application/ports';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case';
import { OpenWalletUseCase } from './application/wallets/open-wallet.use-case';
import {
  ReconcileWalletUseCase,
  type ReconciliationAlert,
} from './application/wallets/reconcile-wallet.use-case';
import { sqsClientProvider } from './infrastructure/messaging/sqs.client';
import { createMikroOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmWalletReadRepository } from './infrastructure/persistence/mikro-orm.read-repository';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm.unit-of-work';
import { LoggingReconciliationAlert } from './infrastructure/reconciliation-alert';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { ProviderAuthGuard } from './interface/http/auth.guard';
import { HealthController } from './interface/http/health.controller';
import { HttpExceptionFilter } from './interface/http/http-exception.filter';
import { CLOCK, ID_GENERATOR, RECONCILIATION_ALERT, UNIT_OF_WORK, WALLET_READS } from './interface/http/tokens';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';

export interface AppOptions {
  databaseUrl: string;
}

/**
 * Composição: o ÚNICO lugar que conhece as implementações concretas.
 * Use cases recebem só portas — trocar MikroORM por outra coisa mexe só aqui.
 */
@Module({})
export class AppModule {
  static register(options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createMikroOrmConfig(options.databaseUrl))],
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        sqsClientProvider,
        ProviderAuthGuard,
        { provide: APP_FILTER, useClass: HttpExceptionFilter },

        // ---- portas → implementações
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: RECONCILIATION_ALERT, useClass: LoggingReconciliationAlert },
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm.em),
        },
        {
          provide: WALLET_READS,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmWalletReadRepository(orm.em),
        },

        // ---- use cases (classes puras, sem decorators do Nest)
        {
          provide: OpenWalletUseCase,
          inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new OpenWalletUseCase(uow, ids, clock),
        },
        {
          provide: ProcessWagerTransactionUseCase,
          inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
            new ProcessWagerTransactionUseCase(uow, ids, clock),
        },
        {
          provide: ReconcileWalletUseCase,
          inject: [WALLET_READS, RECONCILIATION_ALERT],
          useFactory: (reads: WalletReadRepository, alert: ReconciliationAlert) =>
            new ReconcileWalletUseCase(reads, alert),
        },
      ],
    };
  }
}
