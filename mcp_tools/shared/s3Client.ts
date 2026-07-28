// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConstructor = new (...args: any[]) => any;

// Dynamic import avoids moduleResolution:NodeNext issues with CJS packages that have empty exports maps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getS3Sdk(): Promise<{ S3Client: AnyConstructor; GetObjectCommand: AnyConstructor; ListObjectsV2Command: AnyConstructor }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import("@aws-sdk/client-s3") as any;
}

import { envOptional } from "../config.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function client(): Promise<any> {
  if (_client) return _client;
  const { S3Client } = await getS3Sdk();
  const credentials = process.env["AWS_ACCESS_KEY_ID"]
    ? {
        accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
        secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] ?? "",
      }
    : undefined;
  _client = new S3Client({
    region: envOptional("SENTISCORE_S3_REGION", envOptional("AWS_REGION", "us-east-2")),
    ...(credentials ? { credentials } : {}),
  });
  return _client;
}

export async function s3GetText(bucket: string, key: string): Promise<string> {
  const { GetObjectCommand } = await getS3Sdk();
  const c = await client();
  const resp = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return resp.Body ? await resp.Body.transformToString("utf-8") : "";
}

export async function s3ListKeys(bucket: string, prefix: string): Promise<string[]> {
  const { ListObjectsV2Command } = await getS3Sdk();
  const c = await client();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const resp = await c.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    for (const obj of resp.Contents ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (obj.Key) keys.push(obj.Key as string);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    token = resp.NextContinuationToken as string | undefined;
  } while (token);
  return keys;
}

export async function s3ListPrefixes(bucket: string, prefix: string): Promise<string[]> {
  const { ListObjectsV2Command } = await getS3Sdk();
  const c = await client();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const resp = await c.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/" }),
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((resp.CommonPrefixes as Array<{ Prefix?: string }>) ?? []).map((p) => p.Prefix ?? "").filter(Boolean);
}

export async function s3GetNewestKey(bucket: string, prefix: string): Promise<string | undefined> {
  const { ListObjectsV2Command } = await getS3Sdk();
  const c = await client();
  let token: string | undefined;
  let newest: { key: string; modified: number } | undefined;
  do {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const resp = await c.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    for (const obj of resp.Contents ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!obj.Key) continue;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const t = (obj.LastModified as Date | undefined)?.getTime() ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (!newest || t > newest.modified) newest = { key: obj.Key as string, modified: t };
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    token = resp.NextContinuationToken as string | undefined;
  } while (token);
  return newest?.key;
}
