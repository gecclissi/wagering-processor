#!/bin/bash
# Cria as filas SQS do desafio. Roda dentro do container do LocalStack.
set -euo pipefail

# 1) DLQ primeiro: a fila principal precisa do ARN dela.
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text --query QueueUrl)" \
  --attribute-names QueueArn --output text --query Attributes.QueueArn)

# 2) Fila de entrada. Após 5 recebimentos sem ack, a mensagem vai para a DLQ.
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# 3) Fila de saída para os eventos de integração publicados pela outbox.
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true

echo "SQS queues ready"
