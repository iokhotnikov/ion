import {
  RDSDataClient,
  ExecuteStatementCommand,
} from "@aws-sdk/client-rds-data";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { OpenAI } from "openai";
import { useClient } from "../../helpers/aws/client";

export type IngestEvent = {
  text?: string;
  image?: string;
  metadata: any;
};

export type RetrieveEvent = {
  text?: string;
  image?: string;
  metadata: any;
  threshold?: number;
  count?: number;
};

export type RemoveEvent = {
  metadata: string;
};

const {
  CLUSTER_ARN,
  SECRET_ARN,
  DATABASE_NAME,
  TABLE_NAME,
  MODEL,
  MODEL_PROVIDER,
  // modal provider dependent (optional)
  OPENAI_API_KEY,
} = process.env;

export async function ingest(event: IngestEvent) {
  const embedding = await generateEmbedding(event.text, event.image);
  const metadata = JSON.stringify(event.metadata);
  await storeEmbedding(metadata, embedding);
}
export async function retrieve(event: RetrieveEvent) {
  const embedding = await generateEmbedding(event.text, event.image);
  const metadata = JSON.stringify(event.metadata);
  const result = await queryEmbeddings(
    metadata,
    embedding,
    event.threshold ?? 0,
    event.count ?? 10
  );
  return {
    results: result,
  };
}
export async function remove(event: RemoveEvent) {
  const metadata = JSON.stringify(event.metadata);
  await removeEmbedding(metadata);
}

async function generateEmbedding(text?: string, image?: string) {
  if (MODEL_PROVIDER === "openai") {
    return await generateEmbeddingOpenAI(text!);
  }
  return await generateEmbeddingBedrock(text, image);
}

async function generateEmbeddingOpenAI(text: string) {
  const openAi = new OpenAI({ apiKey: OPENAI_API_KEY });
  const embeddingResponse = await openAi.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
    encoding_format: "float",
  });
  return embeddingResponse.data[0].embedding;
}

async function generateEmbeddingBedrock(text?: string, image?: string) {
  const ret = await useClient(BedrockRuntimeClient).send(
    new InvokeModelCommand({
      body: JSON.stringify({
        inputText: text,
        inputImage: image,
      }),
      modelId: MODEL,
      contentType: "application/json",
      accept: "*/*",
    })
  );
  const payload = JSON.parse(Buffer.from(ret.body.buffer).toString());
  return payload.embedding;
}

async function storeEmbedding(metadata: string, embedding: number[]) {
  await useClient(RDSDataClient).send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
      sql: `INSERT INTO ${TABLE_NAME} (embedding, metadata)
              VALUES (ARRAY[${embedding.join(",")}], :metadata)`,
      parameters: [
        {
          name: "metadata",
          value: { stringValue: metadata },
          typeHint: "JSON",
        },
      ],
    })
  );
}

async function queryEmbeddings(
  metadata: string,
  embedding: number[],
  threshold: number,
  count: number
) {
  const score = `embedding <=> (ARRAY[${embedding.join(",")}])::vector`;
  const ret = await useClient(RDSDataClient).send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
      sql: `SELECT id, metadata, ${score} AS score FROM ${TABLE_NAME}
                WHERE ${score} < ${1 - threshold}
                AND metadata @> :metadata
                ORDER BY ${score}
                LIMIT ${count}`,
      parameters: [
        {
          name: "metadata",
          value: { stringValue: metadata },
          typeHint: "JSON",
        },
      ],
    })
  );
  return ret.records?.map((record) => ({
    id: record[0].stringValue,
    metadata: JSON.parse(record[1].stringValue!),
    score: 1 - record[2].doubleValue!,
  }));
}

async function removeEmbedding(metadata: string) {
  await useClient(RDSDataClient).send(
    new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
      sql: `DELETE FROM ${TABLE_NAME} WHERE metadata @> :metadata`,
      parameters: [
        {
          name: "metadata",
          value: { stringValue: metadata },
          typeHint: "JSON",
        },
      ],
    })
  );
}