import { InvariantViolationError } from '../shared/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/**
 * Registro de "esta mensagem já foi tratada por este consumidor".
 * Identidade = (consumerName, messageId). Gravado na MESMA transação SQL do
 * efeito financeiro: se o registro existe, o efeito também existe.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim() === '' || props.consumerName.trim() === '') {
      throw new InvariantViolationError('Inbox message needs messageId and consumerName');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`Inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }

  /** Mesmo messageId com conteúdo diferente não é redelivery: é um erro do produtor. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
