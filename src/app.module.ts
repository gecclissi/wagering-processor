import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config';
import { sqsClientProvider } from './infrastructure/messaging/sqs.client';
import { HealthController } from './interface/http/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [HealthController],
  providers: [sqsClientProvider],
})
export class AppModule {}
