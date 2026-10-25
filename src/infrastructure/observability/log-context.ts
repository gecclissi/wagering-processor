import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de rastreio que todo log da operação em andamento carrega. */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  sqsMessageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: string | number | boolean | undefined;
}

// AsyncLocalStorage: um "contexto" que acompanha a cadeia de chamadas
// assíncronas (como uma variável por requisição). Quem inicia a operação
// (HTTP, consumer, worker) abre o contexto; qualquer log lá dentro — até no
// fundo da infraestrutura — sai com o correlationId, sem passar parâmetro.
const storage = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  return storage.run({ ...fields }, fn);
}

/** Acrescenta campos ao contexto atual (ex.: transactionId, quando passa a existir). */
export function addLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}
