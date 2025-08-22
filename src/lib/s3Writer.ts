import { 
  S3Client, 
  PutObjectCommand, 
  AbortMultipartUploadCommand 
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const client = new S3Client({});

interface UploadOptions {
  contentLength?: number;
  contentType?: string;
}

export async function upload(
  bucket: string, 
  key: string, 
  body: Readable, 
  options: UploadOptions = {}
): Promise<void> {
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: options.contentLength,
        ContentType: options.contentType
      })
    );
  } catch (error) {
    // Attempt to abort any multipart upload on failure
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: (error as any)?.UploadId
        })
      );
    } catch (abortError) {
      // Log but don't throw - we want to throw the original error
      console.error('Failed to abort multipart upload:', abortError);
    }

    throw error;
  }
}
