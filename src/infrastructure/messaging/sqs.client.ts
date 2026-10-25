import { SQSClient } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';
import { env } from '../../config/env';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  useFactory: () =>
    new SQSClient({
      region: env.aws.region,
      // Em ambiente local aponta para o LocalStack; em produção fica undefined (AWS real).
      ...(env.aws.endpoint ? { endpoint: env.aws.endpoint } : {}),
    }),
};
