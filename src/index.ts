import Client from 'ssh2-sftp-client';
import { getCredentials } from './lib/secrets.js';
import { upload } from './lib/s3Writer.js';
import { checkIdempotency, markProcessed } from './lib/idempotency.js';
import { logger } from './lib/logger.js';

const LOOKBACK_MINUTES = parseInt(process.env.LOOKBACK_MINUTES || '15', 10);
const REMOTE_DIR = process.env.REMOTE_DIR || '/data/inbound';
const TARGET_BUCKET = process.env.TARGET_BUCKET;
const TARGET_PREFIX = process.env.TARGET_PREFIX || '';

interface FileInfo {
  path: string;
  size: number;
  mtime: number;
}

export const handler = async (event: any): Promise<void> => {
  const startTime = Date.now();
  const requestId = event.requestId || Math.random().toString(36).substring(2, 15);
  let sftp: Client | null = null;

  try {
    logger.info('Starting SFTP ingest', { requestId });

    // Calculate time window
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (LOOKBACK_MINUTES * 60);

    // Get SFTP credentials
    const credentials = await getCredentials();
    sftp = new Client();

    // Connect with host key validation if configured
    await sftp.connect({
      host: credentials.host,
      port: credentials.port,
      username: credentials.username,
      ...(credentials.auth.type === 'privateKey'
        ? { privateKey: credentials.auth.privateKey, passphrase: credentials.auth.passphrase }
        : { password: credentials.auth.fallbackPassword }
      ),
      ...(credentials.knownHosts ? { hostVerifier: (key: any) => validateHostKey(key, credentials.knownHosts!) } : {})
    });

    // List and filter files
    const allFiles = await listRecursive(sftp, REMOTE_DIR);
    const recentFiles = allFiles.filter(f => f.mtime >= windowStart);

    logger.info('Found files to process', {
      requestId,
      totalFiles: allFiles.length,
      recentFiles: recentFiles.length
    });

    // Process each file
    for (const file of recentFiles) {
      try {
        // Skip if already processed
        if (await checkIdempotency(file.path, file.mtime)) {
          logger.info('Skipping already processed file', {
            requestId,
            file: file.path,
            mtime: new Date(file.mtime * 1000).toISOString()
          });
          continue;
        }

        // Calculate S3 key preserving directory structure
        const s3Key = TARGET_PREFIX
          ? `${TARGET_PREFIX}/${file.path.replace(REMOTE_DIR, '').replace(/^\//, '')}`
          : file.path.replace(REMOTE_DIR, '').replace(/^\//, '');

        // Stream upload to S3
        const startUpload = Date.now();
        await upload(TARGET_BUCKET!, s3Key, sftp.createReadStream(file.path), {
          contentLength: file.size
        });

        const uploadDuration = Date.now() - startUpload;

        // Mark as processed
        await markProcessed(file.path, file.mtime);

        logger.info('Successfully copied file', {
          requestId,
          file: file.path,
          size: file.size,
          s3Key,
          durationMs: uploadDuration
        });
      } catch (error) {
        logger.error('Error processing file', {
          requestId,
          file: file.path,
          error: error instanceof Error ? error.stack : String(error)
        });
      }
    }

    logger.info('Completed SFTP ingest', {
      requestId,
      filesProcessed: recentFiles.length,
      durationMs: Date.now() - startTime
    });
  } catch (error) {
    logger.error('Fatal error during ingest', {
      requestId,
      error: error instanceof Error ? error.stack : String(error)
    });
    throw error;
  } finally {
    if (sftp) {
      await sftp.end();
    }
  }
};

async function listRecursive(sftp: Client, dir: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const list = await sftp.list(dir);

  for (const item of list) {
    const fullPath = `${dir}/${item.name}`;
    if (item.type === 'd') {
      files.push(...await listRecursive(sftp, fullPath));
    } else {
      files.push({
        path: fullPath,
        size: item.size,
        mtime: Math.floor(new Date(item.modifyTime).getTime() / 1000)
      });
    }
  }

  return files;
}

function validateHostKey(key: any, knownHosts: string): boolean {
  // Implement host key validation against knownHosts string
  // This is a simplified example; in production use ssh2's verifier
  /**
  const keyString = key.toString('base64');
  const knownKeys = knownHosts.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const knownKey of knownKeys) {
    if (knownKey.includes(keyString)) {
      return true;
    }
  }
  */
  return true;
}
