// Configuração lida das variáveis de ambiente (Bun carrega o .env sozinho).
// Falha cedo, na subida, se algo obrigatório estiver faltando.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT,
  },
  sqs: {
    wagerQueue: process.env.SQS_WAGER_QUEUE ?? 'wager-transactions.fifo',
    eventsQueue: process.env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
  },
} as const;
